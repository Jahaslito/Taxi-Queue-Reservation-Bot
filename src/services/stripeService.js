// ─── Stripe Service ───────────────────────────────────────────────────────────
// Thin wrapper around the Stripe SDK.
// Lazy-initialised so the server doesn't crash at boot when the key is absent
// in dev (tests can still run; billing routes will simply 500 if called).

const { appUrl } = require('../config/env');

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    const Stripe = require('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-04-10' });
  }
  return _stripe;
}

/**
 * Create a Stripe Customer for a driver.
 * Called the first time a driver initiates checkout.
 */
async function createCustomer(driver) {
  return getStripe().customers.create({
    email:    driver.email,
    name:     driver.name,
    metadata: {
      driver_id:      String(driver.id),
      vehicle_number: driver.vehicle_number || '',
    },
  });
}

const DEFAULT_TRIAL_DAYS = 14;

/**
 * Compute the trial config for a Checkout Session.
 *
 * Default: 14-day trial via `trial_period_days`. Stripe collects card details
 * upfront but charges nothing until day 15.
 *
 * Pause-window override: when `STRIPE_PAUSE_UNTIL` is set to a future epoch
 * (seconds), we run the script-style billing pause for existing subscribers.
 * To keep NEW sign-ups consistent with that — no charges inside the pause
 * window — we extend their trial only as far as needed to clear the window.
 * Specifically: `trial_end = max(pauseUntil, now + 14 days)`. So:
 *   • A driver signing up at the start of a 21-day pause → 21-day trial
 *   • A driver signing up halfway → still gets their normal 14-day trial
 *     (their natural end-date falls after pause expiry, no extension needed)
 *
 * Pure / no I/O — exported for unit testing via `_trialConfig`.
 *
 * @param {number} nowSec       — current Unix epoch in seconds
 * @param {number} pauseUntilSec — value of STRIPE_PAUSE_UNTIL (0 = no pause)
 * @returns {{trial_end: number} | {trial_period_days: number}}
 */
function trialConfig(nowSec, pauseUntilSec) {
  if (!Number.isFinite(pauseUntilSec) || pauseUntilSec <= nowSec) {
    return { trial_period_days: DEFAULT_TRIAL_DAYS };
  }
  const naturalTrialEnd = nowSec + DEFAULT_TRIAL_DAYS * 24 * 60 * 60;
  return { trial_end: Math.max(pauseUntilSec, naturalTrialEnd) };
}

/**
 * Create a hosted Checkout Session for a new subscription.
 * The trial period is handled on the subscription_data side so Stripe
 * collects card details upfront but charges nothing until the trial ends.
 *
 * See `trialConfig` above for the pause-window behavior.
 */
async function createCheckoutSession({ customerId, driverId, successUrl, cancelUrl }) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID is not set');

  const pauseUntilSec = parseInt(process.env.STRIPE_PAUSE_UNTIL ?? '0', 10);
  const nowSec        = Math.floor(Date.now() / 1000);

  return getStripe().checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    mode:                 'subscription',
    line_items:           [{ price: priceId, quantity: 1 }],
    subscription_data:    trialConfig(nowSec, pauseUntilSec),
    success_url:          successUrl || `${appUrl}/?billing=success`,
    cancel_url:           cancelUrl  || `${appUrl}/?billing=canceled`,
    // Store driver_id so the webhook can identify which driver subscribed
    metadata:             { driver_id: String(driverId) },
  });
}

/**
 * Open the Stripe Customer Portal for an existing subscriber.
 * Used for updating payment method, cancelling, or viewing invoices.
 */
async function createPortalSession(customerId, returnUrl) {
  return getStripe().billingPortal.sessions.create({
    customer:   customerId,
    return_url: returnUrl || `${appUrl}/`,
  });
}

/**
 * Retrieve a subscription object (used by the webhook after checkout.session.completed).
 */
async function retrieveSubscription(subscriptionId) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

/**
 * Verify the Stripe-Signature header and reconstruct the event.
 * Throws if the signature is invalid.
 */
function constructWebhookEvent(rawBody, signature, secret) {
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  createCustomer,
  createCheckoutSession,
  createPortalSession,
  retrieveSubscription,
  constructWebhookEvent,
  // Exported for unit testing — not called by route handlers.
  _trialConfig: trialConfig,
};
