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

/**
 * Create a hosted Checkout Session for a new subscription.
 * The trial period is handled on the subscription_data side so Stripe
 * collects card details upfront but charges nothing until day 15.
 */
async function createCheckoutSession({ customerId, driverId, successUrl, cancelUrl }) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID is not set');

  return getStripe().checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    mode:                 'subscription',
    line_items:           [{ price: priceId, quantity: 1 }],
    subscription_data:    { trial_period_days: 14 },
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
};
