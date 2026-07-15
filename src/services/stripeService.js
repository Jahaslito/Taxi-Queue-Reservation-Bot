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

// Length of the free trial for NEW sign-ups, in days. Env-driven (read at
// call-time) so the trial can be turned off (or restored) without a code deploy:
//   • TRIAL_PERIOD_DAYS unset or 0 → NO free trial: the card is charged at
//     Checkout, exactly like the `skipTrial` (grandfathered/reactivation) path.
//   • TRIAL_PERIOD_DAYS=14         → the classic 14-day free trial.
// Non-numeric / negative values coerce to 0 (trial off) — the safe default.
function trialPeriodDays() {
  const n = parseInt(process.env.TRIAL_PERIOD_DAYS ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute the trial config for a Checkout Session.
 *
 * Trial OFF (`TRIAL_PERIOD_DAYS` unset/0, the current default): behaves exactly
 * like `skipTrialConfig` — the card is charged at Checkout, with the first
 * charge deferred only if a billing pause is active. This is how the free
 * trial is "turned off" for new customers.
 *
 * Trial ON (`TRIAL_PERIOD_DAYS > 0`): an N-day trial via `trial_period_days`.
 * Stripe collects card details upfront but charges nothing until day N+1.
 *
 * Pause-window override (trial ON only): when `STRIPE_PAUSE_UNTIL` is set to a
 * future epoch (seconds), we run the script-style billing pause for existing
 * subscribers. To keep NEW sign-ups consistent with that — no charges inside
 * the pause window — we extend their trial only as far as needed to clear it.
 * Specifically: `trial_end = max(pauseUntil, now + N days)`. So:
 *   • A driver signing up at the start of a 21-day pause → 21-day trial
 *   • A driver signing up halfway → still gets their normal N-day trial
 *     (their natural end-date falls after pause expiry, no extension needed)
 *
 * Pure / no I/O — exported for unit testing via `_trialConfig`.
 *
 * @param {number} nowSec       — current Unix epoch in seconds
 * @param {number} pauseUntilSec — value of STRIPE_PAUSE_UNTIL (0 = no pause)
 * @returns {{trial_end: number} | {trial_period_days: number} | null}
 */
function trialConfig(nowSec, pauseUntilSec) {
  const days = trialPeriodDays();
  // Trial disabled → charge at Checkout (still honoring any active pause).
  if (days <= 0) {
    return skipTrialConfig(nowSec, pauseUntilSec);
  }
  if (!Number.isFinite(pauseUntilSec) || pauseUntilSec <= nowSec) {
    return { trial_period_days: days };
  }
  const naturalTrialEnd = nowSec + days * 24 * 60 * 60;
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
 * With the free trial OFF (`TRIAL_PERIOD_DAYS` unset/0 — the default), the
 * non-skipTrial path also charges at Checkout, so `skipTrial` becomes a no-op;
 * it only matters when the trial is re-enabled (`TRIAL_PERIOD_DAYS>0`), where
 * it still charges grandfathered/reactivating drivers at Checkout.
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

// Friendly fallbacks for common decline codes when Stripe supplies no message.
// Stripe's own `message` is already cardholder-appropriate, so these are only
// used when it's absent.
const DECLINE_CODE_TEXT = {
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card:       'Your card has expired.',
  incorrect_cvc:      "Your card's security code is incorrect.",
  card_declined:      'Your card was declined.',
  do_not_honor:       'Your card was declined by your bank.',
  generic_decline:    'Your card was declined.',
};

/**
 * Build the human-readable payment-failure reason we store on the driver row
 * and show on the Payment Required screen / email. Accepts the fields of a
 * PaymentIntent's `last_payment_error` or of a thrown Stripe card error:
 *   { message, declineCode, brand, last4 }
 * Always returns a non-empty string.
 *
 * Pure / no I/O — exported for unit testing via `_formatDeclineReason`.
 */
function formatDeclineReason({ message, declineCode, brand, last4 } = {}) {
  const reason = message
    || DECLINE_CODE_TEXT[declineCode]
    || 'Your card was declined.';
  const card = last4
    ? `${brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card'} •••• ${last4}: `
    : '';
  // Column is varchar(300) — keep well under it.
  return (card + reason).slice(0, 280);
}

/**
 * Retrieve a PaymentIntent (used by the invoice.payment_failed webhook to read
 * `last_payment_error` — the decline reason shown to the driver).
 */
async function retrievePaymentIntent(paymentIntentId) {
  return getStripe().paymentIntents.retrieve(paymentIntentId);
}

/**
 * Pay EVERY open (finalized, awaiting-payment) invoice for a customer, on the
 * given card. This is the single money-recovery primitive shared by both
 * card-add paths (in-app reactivate + Billing-Portal card swap).
 *
 * Why "all open" and not just the subscription's latest_invoice: a driver can
 * owe more than one missed renewal, and by the time they re-add a card the
 * past_due invoice is often no longer `latest_invoice`. Collecting only the
 * latest silently forgives the rest — the exact leak that gifted a free month.
 *
 * Per-invoice failures are caught and reported (not thrown) so one decline
 * doesn't abandon the others; `allSettled` tells the caller whether the balance
 * is now fully cleared. Idempotent: a paid invoice leaves the `open` set, so
 * re-running is a safe no-op.
 *
 * @returns {{ attempted: number, paidCount: number, amountPaid: number, failed: number, allSettled: boolean }}
 */
async function payAllOpenInvoices(customerId, paymentMethodId) {
  const stripe = getStripe();
  const open   = await stripe.invoices.list({ customer: customerId, status: 'open', limit: 100 });

  const result = { attempted: open.data.length, paidCount: 0, amountPaid: 0, failed: 0, lastFailureReason: null };
  for (const invoice of open.data) {
    try {
      const paid = await stripe.invoices.pay(
        invoice.id,
        paymentMethodId ? { payment_method: paymentMethodId } : {},
      );
      result.paidCount  += 1;
      result.amountPaid += paid.amount_paid || 0;
    } catch (err) {
      result.failed += 1;
      // Card errors carry the cardholder-facing reason — keep it so callers can
      // store/show it (drivers shouldn't retry a bad card blind).
      result.lastFailureReason = formatDeclineReason({
        message:     err.message,
        declineCode: err.decline_code,
      });
      console.error(`[Stripe] Failed to pay invoice ${invoice.id} for ${customerId}: ${err.message}`);
    }
  }
  result.allSettled = result.failed === 0;
  return result;
}

/**
 * Settle a past_due subscription using the card just collected via a setup-mode
 * Checkout Session. Called from the webhook on `checkout.session.completed`.
 *
 * Steps:
 *   1. Resolve the new payment method from the completed SetupIntent.
 *   2. Make it the customer + subscription default (so future renewals use it).
 *   3. Pay ALL outstanding invoices IMMEDIATELY — we don't wait for Stripe's
 *      dunning retries, the driver is charged the moment they add a card.
 *
 * Paying the open invoices transitions the subscription past_due → active, which
 * fires `invoice.payment_succeeded` + `customer.subscription.updated` — both
 * already handled to re-activate the driver. Never throws on a decline; the
 * result reports what settled so the caller/webhook can log it (the subscription
 * simply stays past_due until the balance clears, as before).
 *
 * @returns {{ paymentMethodId: string, invoicePaid: boolean, attempted: number, paidCount: number, amountPaid: number, failed: number, allSettled: boolean }}
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

  if (subscriptionId) {
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: paymentMethodId,
    });
  }

  // Settle the entire outstanding balance now, on this card.
  const result = await payAllOpenInvoices(customerId, paymentMethodId);
  return { paymentMethodId, invoicePaid: result.paidCount > 0, ...result };
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
 * List every subscription (any status) for a customer, newest first.
 * Used to verify payment state directly against Stripe when webhook delivery
 * can't be relied on (the paywall return path), and to guard Checkout against
 * creating a duplicate subscription for a driver who already paid.
 */
async function listSubscriptions(customerId) {
  const res = await getStripe().subscriptions.list({
    customer: customerId,
    status:   'all',
    limit:    20,
  });
  return res.data;
}

// Ranking for pickRelevantSubscription: lower = more authoritative about the
// driver's real access state. A live paid sub always beats a dead one, no
// matter how recently the dead one was created.
const SUB_STATUS_RANK = {
  active:     0,
  trialing:   1,
  past_due:   2,
  unpaid:     3,
  incomplete: 4,
  canceled:   5,
};

/**
 * Pick the single subscription that best represents the customer's access
 * state: best status first (see SUB_STATUS_RANK), most recently created among
 * ties. Returns null for an empty list.
 *
 * Pure / no I/O — exported for unit testing via `_pickRelevantSubscription`.
 */
function pickRelevantSubscription(subscriptions = []) {
  if (!subscriptions.length) return null;
  return [...subscriptions].sort((a, b) => {
    const rank = (s) => SUB_STATUS_RANK[s.status] ?? 9;
    return rank(a) - rank(b) || (b.created || 0) - (a.created || 0);
  })[0];
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
  payAllOpenInvoices,
  reactivateFromSetupIntent,
  retrieveCheckoutSession,
  createPortalSession,
  retrieveSubscription,
  retrievePaymentIntent,
  listSubscriptions,
  pickRelevantSubscription,
  formatDeclineReason,
  resumeSubscription,
  scheduleCancelAtPeriodEnd,
  constructWebhookEvent,
  // Exported for unit testing — not called by route handlers.
  _trialConfig:              trialConfig,
  _skipTrialConfig:          skipTrialConfig,
  _pickRelevantSubscription: pickRelevantSubscription,
  _formatDeclineReason:      formatDeclineReason,
};
