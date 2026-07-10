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
//   payment_method.attached            → card added/updated via portal → pay any
//                                         open invoices, then lift card lock

const express = require('express');
const Driver  = require('../models/Driver');
const { constructWebhookEvent, retrieveSubscription, reactivateFromSetupIntent, payAllOpenInvoices } = require('../services/stripeService');
const { sendPaymentFailedEmail } = require('../services/emailService');

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

          // Reactivation: card collected via a setup-mode Checkout for a driver
          // whose subscription went past_due. Attach the card + pay the open
          // invoice immediately. Re-activation itself is handled by the
          // resulting invoice.payment_succeeded / subscription.updated events.
          if (session.mode === 'setup' && session.metadata?.purpose === 'reactivate') {
            const driver = await Driver.findByStripeCustomerId(session.customer);
            if (!driver) {
              console.warn(`[Stripe Webhook] setup reactivate — no driver for customer ${session.customer}`);
              break;
            }
            const { invoicePaid } = await reactivateFromSetupIntent({
              customerId:     session.customer,
              subscriptionId: driver.stripe_subscription_id,
              setupIntentId:  session.setup_intent,
            });
            console.log(`[Stripe Webhook] Driver ${driver.id} reactivation setup — invoice ${invoicePaid ? 'paid' : 'not charged (none open)'}`);
            break;
          }

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
            // Fresh subscription — drop any prior scheduled-cancel date.
            subscription_cancel_at: null,
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

          // Scheduled cancellation ("cancel at period end"): the subscription
          // stays active/trialing but Stripe stamps cancel_at with the date
          // access will end. Persist it to drive the grace-window banner; clear
          // it the moment the schedule is removed (driver un-cancels) or the sub
          // is deleted. `deleted` events carry cancel_at_period_end=false, so
          // this naturally clears on final cancellation too.
          const cancelAt = (sub.cancel_at_period_end && sub.cancel_at)
            ? new Date(sub.cancel_at * 1000)
            : null;

          // Also persist stripe_subscription_id here so the link is recoverable
          // even if checkout.session.completed never reached this endpoint.
          await Driver.update(driver.id, {
            stripe_subscription_id:  sub.id,
            subscription_status:     sub.status,
            trial_ends_at:           sub.trial_end ? new Date(sub.trial_end * 1000) : null,
            subscription_cancel_at:  cancelAt,
          });

          console.log(`[Stripe Webhook] Driver ${driver.id} ${event.type}: ${sub.status}${cancelAt ? ` (cancels ${cancelAt.toISOString()})` : ''}`);
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
            subscription_status:    'active',
            is_active:              true,
            card_required_by:       null,
            subscription_cancel_at: null,
          });
          console.log(`[Stripe Webhook] Driver ${driver.id} ${event.type} → active`);
          break;
        }

        // Fires when a driver adds a card via the Billing Portal without a new
        // checkout (e.g. updating their payment method).
        case 'payment_method.attached': {
          const pm     = event.data.object;
          const driver = await Driver.findByStripeCustomerId(pm.customer);
          if (!driver) break;

          // Sweep every OPEN invoice with the new card FIRST. A portal card-swap
          // must never reactivate a driver while a past_due renewal goes
          // uncollected — that silently gifts a free month (the leak this fixes).
          // Each successful payment fires invoice.payment_succeeded, which flips
          // the driver back to active via the handler above; so we don't set the
          // status here, we only lift the card-enforcement lock below.
          try {
            const swept = await payAllOpenInvoices(pm.customer, pm.id);
            if (swept.attempted > 0) {
              console.log(`[Stripe Webhook] Driver ${driver.id} payment_method.attached — settled ${swept.paidCount}/${swept.attempted} open invoice(s) ($${(swept.amountPaid / 100).toFixed(2)})${swept.allSettled ? '' : ' — balance NOT fully cleared'}`);
            }
          } catch (err) {
            console.error(`[Stripe Webhook] Driver ${driver.id} payment_method.attached — invoice sweep failed:`, err.message);
          }

          // Lift a card-enforcement lock (card_required cohort). Reactivation
          // from past_due is driven by the invoice.payment_succeeded events above.
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

          // Notify the driver their account is paused and they must re-add a
          // card. Non-blocking — a mail failure must not 5xx the webhook.
          if (driver.email) {
            sendPaymentFailedEmail(driver).catch((err) =>
              console.error(`[Stripe Webhook] Failed to send payment-failed email to driver ${driver.id}:`, err.message),
            );
          }
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
