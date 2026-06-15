// ─── Stripe Webhook Route ─────────────────────────────────────────────────────
// Mounted BEFORE express.json() so the raw body is preserved for signature
// verification. Uses express.raw() locally.
//
// Registered events:
//   checkout.session.completed         → subscription created / trial started
//   customer.subscription.created      → fallback link if checkout.session.completed isn't subscribed
//   customer.subscription.updated      → status change (active, past_due, etc.)
//   customer.subscription.deleted      → subscription cancelled
//   invoice.payment_succeeded / paid   → payment succeeded → ensure status = active
//   invoice.payment_failed             → payment failed → status = past_due
//   payment_method.attached            → card added via portal → lift card lock

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
            // A card is now on file — lift any card-enforcement lock and
            // re-activate a driver the sweep had deactivated.
            is_active:              true,
            card_required_by:       null,
          });

          console.log(`[Stripe Webhook] Driver ${driverId} subscribed — status: ${sub.status}`);
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub    = event.data.object;
          const driver = await Driver.findByStripeCustomerId(sub.customer);
          if (!driver) {
            console.warn(`[Stripe Webhook] ${event.type} — no driver for customer ${sub.customer}`);
            break;
          }

          // Also persist stripe_subscription_id here so the link is recoverable
          // even if checkout.session.completed never reached this endpoint.
          await Driver.update(driver.id, {
            stripe_subscription_id: sub.id,
            subscription_status:    sub.status,
            trial_ends_at:          sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          });

          console.log(`[Stripe Webhook] Driver ${driver.id} ${event.type}: ${sub.status}`);
          break;
        }

        // Stripe emits `invoice.payment_succeeded` on newer API versions;
        // older accounts still see `invoice.paid`. Handle both.
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          const driver  = await Driver.findByStripeCustomerId(invoice.customer);
          if (!driver) break;

          // A successful charge means a working card is on file — clear any
          // card-enforcement lock and re-activate.
          await Driver.update(driver.id, {
            subscription_status: 'active',
            is_active:           true,
            card_required_by:    null,
          });
          console.log(`[Stripe Webhook] Driver ${driver.id} ${event.type} → active`);
          break;
        }

        // Fires when a driver adds a card via the Billing Portal without a new
        // checkout (e.g. updating their payment method). Lift the lock too.
        case 'payment_method.attached': {
          const pm     = event.data.object;
          const driver = await Driver.findByStripeCustomerId(pm.customer);
          if (!driver) break;
          if (!driver.card_required_by && driver.is_active) break; // nothing to lift

          await Driver.update(driver.id, { is_active: true, card_required_by: null });
          console.log(`[Stripe Webhook] Driver ${driver.id} payment_method.attached → card lock lifted`);
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
