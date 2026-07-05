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
 * Compute the subscription config when the trial is intentionally skipped.
 *
 * Used for grandfathered drivers who already had free access and are now
 * reactivating by adding a card — they should be charged at checkout rather
 * than handed a fresh 14-day trial.
 *
 * Pause-window override: if a billing pause is active we must still NOT charge
 * inside the window (consistent with `trialConfig` and pause-subscriptions.js),
 * so we defer the first charge to exactly the pause-end via `trial_end`. No
 * extra 14 days — the moment the pause clears, billing begins.
 *
 * Returns `null` when there is nothing to set (immediate charge at checkout).
 *
 * Pure / no I/O — exported for unit testing via `_skipTrialConfig`.
 */
function skipTrialConfig(nowSec, pauseUntilSec) {
  if (Number.isFinite(pauseUntilSec) && pauseUntilSec > nowSec) {
    return { trial_end: pauseUntilSec };
  }
  return null;
}

/**
 * Create a hosted Checkout Session for a new subscription.
 * The trial period is handled on the subscription_data side so Stripe
 * collects card details upfront but charges nothing until the trial ends.
 *
 * Pass `skipTrial: true` for grandfathered reactivations — no free trial, the
 * card is charged at checkout (still deferred if a billing pause is active).
 *
 * See `trialConfig` / `skipTrialConfig` above for the pause-window behavior.
 */
async function createCheckoutSession({ customerId, driverId, successUrl, cancelUrl, skipTrial = false }) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID is not set');

  const pauseUntilSec = parseInt(process.env.STRIPE_PAUSE_UNTIL ?? '0', 10);
  const nowSec        = Math.floor(Date.now() / 1000);

  const subscriptionData = skipTrial
    ? skipTrialConfig(nowSec, pauseUntilSec)
    : trialConfig(nowSec, pauseUntilSec);

  return getStripe().checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    mode:                 'subscription',
    line_items:           [{ price: priceId, quantity: 1 }],
    // Omitted entirely when skipTrial has nothing to defer → charge at checkout.
    ...(subscriptionData ? { subscription_data: subscriptionData } : {}),
    success_url:          successUrl || `${appUrl}/?billing=success`,
    cancel_url:           cancelUrl  || `${appUrl}/?billing=canceled`,
    // Store driver_id so the webhook can identify which driver subscribed
    metadata:             { driver_id: String(driverId) },
  });
}

/**
 * Create a hosted Checkout Session in `setup` mode — collects a card on Stripe's
 * hosted page WITHOUT creating a new subscription. Used to re-collect a card for
 * a driver whose existing subscription went `past_due` after a failed payment.
 *
 * The card never touches our servers (no PCI surface). On completion Stripe
 * fires `checkout.session.completed` with `mode: 'setup'`; the webhook then
 * attaches the card and settles the open invoice (see `reactivateFromSetupIntent`).
 *
 * `purpose: 'reactivate'` in metadata lets the webhook distinguish this from any
 * other future setup-mode session.
 */
async function createSetupSession({ customerId, driverId, successUrl, cancelUrl }) {
  return getStripe().checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    mode:                 'setup',
    success_url:          successUrl || `${appUrl}/app/?billing=success`,
    cancel_url:           cancelUrl  || `${appUrl}/app/?billing=canceled`,
    metadata:             { driver_id: String(driverId), purpose: 'reactivate' },
  });
}

/**
 * Settle a past_due subscription using the card just collected via a setup-mode
 * Checkout Session. Called from the webhook on `checkout.session.completed`.
 *
 * Steps:
 *   1. Resolve the new payment method from the completed SetupIntent.
 *   2. Make it the customer + subscription default (so future renewals use it).
 *   3. Pay the subscription's open invoice IMMEDIATELY — we don't wait for
 *      Stripe's dunning retries, the driver is charged the moment they add a card.
 *
 * Paying the open invoice transitions the subscription past_due → active, which
 * fires `invoice.payment_succeeded` + `customer.subscription.updated` — both
 * already handled to re-activate the driver. Throws on a declined charge so the
 * caller can log it (the subscription simply stays past_due, as before).
 *
 * @returns {{ paymentMethodId: string, invoicePaid: boolean }}
 */
async function reactivateFromSetupIntent({ customerId, subscriptionId, setupIntentId }) {
  const stripe = getStripe();

  const si = await stripe.setupIntents.retrieve(setupIntentId);
  const paymentMethodId = si.payment_method;
  if (!paymentMethodId) throw new Error('Setup intent has no payment method attached');

  // Make this card the default for all future charges on the customer.
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  if (!subscriptionId) return { paymentMethodId, invoicePaid: false };

  await stripe.subscriptions.update(subscriptionId, {
    default_payment_method: paymentMethodId,
  });

  // Settle the outstanding invoice now, on this card.
  const sub     = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
  const invoice = sub.latest_invoice;
  if (invoice && invoice.status === 'open') {
    await stripe.invoices.pay(invoice.id, { payment_method: paymentMethodId });
    return { paymentMethodId, invoicePaid: true };
  }

  return { paymentMethodId, invoicePaid: false };
}

/**
 * Retrieve a Checkout Session (used by the webhook to read its setup_intent).
 */
async function retrieveCheckoutSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId);
}

/**
 * Open the Stripe Customer Portal for an existing subscriber.
 * Used for updating payment method, cancelling, or viewing invoices.
 */
async function createPortalSession(customerId, returnUrl) {
  return getStripe().billingPortal.sessions.create({
    customer:   customerId,
    // ?billing=portal-return lets the app re-check the subscription on arrival
    // so a just-scheduled cancellation (or a resubscribe) reflects without a
    // manual refresh.
    return_url: returnUrl || `${appUrl}/app/?billing=portal-return`,
  });
}

/**
 * Retrieve a subscription object (used by the webhook after checkout.session.completed).
 */
async function retrieveSubscription(subscriptionId) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

/**
 * Remove a scheduled "cancel at period end" from a still-live subscription — the
 * driver changed their mind during the grace window. No new charge: the existing
 * subscription simply keeps running. Returns the updated subscription so the
 * caller can read back its status. The resulting customer.subscription.updated
 * webhook clears subscription_cancel_at.
 */
async function resumeSubscription(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

/**
 * Schedule a subscription to stop at the end of the current paid period.
 * No further charge is attempted after the period ends, and the driver keeps
 * the time they already paid for. Idempotent — safe to call on a subscription
 * that is already scheduled to cancel. Returns the updated subscription.
 *
 * Used when an admin deactivates or deletes a driver so we stop billing an
 * account that will no longer be serviced.
 */
async function scheduleCancelAtPeriodEnd(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
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
  createSetupSession,
  reactivateFromSetupIntent,
  retrieveCheckoutSession,
  createPortalSession,
  retrieveSubscription,
  resumeSubscription,
  scheduleCancelAtPeriodEnd,
  constructWebhookEvent,
  // Exported for unit testing — not called by route handlers.
  _trialConfig:     trialConfig,
  _skipTrialConfig: skipTrialConfig,
};
