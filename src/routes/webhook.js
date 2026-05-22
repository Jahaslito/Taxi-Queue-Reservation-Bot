// ─── Stripe Webhook Route ─────────────────────────────────────────────────────
// Mounted BEFORE express.json() so the raw body is preserved for signature
// verification. Uses express.raw() locally.
//
// Registered events:
//   checkout.session.completed   → subscription created / trial started
//   customer.subscription.updated → status change (active, past_due, etc.)
//   customer.subscription.deleted → subscription cancelled
//   invoice.paid                 → payment succeeded → ensure status = active
//   invoice.payment_failed       → payment failed → status = past_due

const express = require('express');
const Driver  = require('../models/Driver');
const { constructWebhookEvent, retrieveSubscription } = require('../services/stripeService');

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !secret) {
      console.warn('[Stripe Webhook] Missing signature or secret — ignored');
      return res.status(400).json({ error: 'Webhook not configured' });
    }

    let event;
    try {
      event = constructWebhookEvent(req.body, sig, secret);
    } catch (err) {
      console.error('[Stripe Webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Always respond 200 quickly; handle errors internally so Stripe doesn't retry
    // for bugs on our side (it retries on 4xx/5xx).
    try {
      switch (event.type) {

        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.mode !== 'subscription') break;

          const driverId = session.metadata?.driver_id;
          if (!driverId) {
            console.warn('[Stripe Webhook] checkout.session.completed — missing driver_id metadata');
            break;
          }

          // Fetch the newly-created subscription to get its status + trial_end
          const sub = await retrieveSubscription(session.subscription);

          await Driver.update(parseInt(driverId, 10), {
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription,
            subscription_status:    sub.status,
            trial_ends_at:          sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          });

          console.log(`[Stripe Webhook] Driver ${driverId} subscribed — status: ${sub.status}`);
          break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub    = event.data.object;
          const driver = await Driver.findByStripeCustomerId(sub.customer);
          if (!driver) {
            console.warn(`[Stripe Webhook] ${event.type} — no driver for customer ${sub.customer}`);
            break;
          }

          await Driver.update(driver.id, {
            subscription_status: sub.status,
            trial_ends_at:       sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          });

          console.log(`[Stripe Webhook] Driver ${driver.id} ${event.type}: ${sub.status}`);
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object;
          const driver  = await Driver.findByStripeCustomerId(invoice.customer);
          if (!driver) break;

          await Driver.update(driver.id, { subscription_status: 'active' });
          console.log(`[Stripe Webhook] Driver ${driver.id} invoice paid → active`);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const driver  = await Driver.findByStripeCustomerId(invoice.customer);
          if (!driver) break;

          await Driver.update(driver.id, { subscription_status: 'past_due' });
          console.log(`[Stripe Webhook] Driver ${driver.id} payment failed → past_due`);
          break;
        }

        default:
          // Unhandled event — silently acknowledge
      }
    } catch (err) {
      // Log but still return 200 so Stripe doesn't retry for our own bugs
      console.error(`[Stripe Webhook] Error handling ${event.type}:`, err.message);
    }

    res.json({ received: true });
  },
);

module.exports = router;
