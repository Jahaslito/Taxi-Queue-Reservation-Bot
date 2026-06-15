'use strict';

// One-time backfill: stamp `card_required_by` on the grandfathered cohort that
// has active access but NO card on file in Stripe.
//
// Why this can't be a simple SQL predicate: a driver can have a
// stripe_customer_id and still have no card — createCheckoutSession/billingPortal
// persist the customer id BEFORE the driver finishes (or abandons) Stripe
// Checkout, leaving an orphan customer with no payment method. So the only
// reliable signal is asking Stripe whether a card actually exists.
//
// For each active driver (is_active=true, subscription_status in active/trialing)
// that has no card_required_by yet, we ask Stripe:
//   • no stripe_customer_id          → no card
//   • customer has a default PM       → has card
//   • else any attached card PM       → has card
//   • customer deleted / not found    → no card
// Drivers with no card get card_required_by = now + GRACE days.
//
// Usage:
//   node scripts/backfill-card-required.js                 ← DRY RUN (default)
//   node scripts/backfill-card-required.js --commit        ← write to the DB
//   node scripts/backfill-card-required.js --days=7        ← grace window (default 7)
//
// Safe to re-run: only stamps drivers whose card_required_by is currently NULL.

require('dotenv').config();
const db     = require('../src/config/database');
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const args    = process.argv.slice(2);
const COMMIT  = args.includes('--commit');
const daysArg = args.find((a) => a.startsWith('--days='));
const GRACE_DAYS = daysArg
  ? parseInt(daysArg.split('=')[1], 10)
  : parseInt(process.env.CARD_GRACE_DAYS ?? '7', 10);

const PREFIX = COMMIT ? '' : '[DRY-RUN] ';
const DEADLINE = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);

/**
 * Ask Stripe whether a usable card is on file for this customer.
 * Returns true if a card exists, false otherwise.
 */
async function hasCardOnFile(customerId) {
  if (!customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
    if (customer.deleted) return false;
    if (customer.invoice_settings?.default_payment_method) return true;

    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    return pms.data.length > 0;
  } catch (err) {
    if (err.code === 'resource_missing') return false; // customer deleted upstream
    throw err; // surface anything else — don't stamp on uncertainty
  }
}

(async () => {
  console.log(`${PREFIX}Backfill card_required_by — grace ${GRACE_DAYS} day(s) → deadline ${DEADLINE.toISOString()}\n`);

  const drivers = await db('drivers')
    .select('id', 'name', 'vehicle_number', 'stripe_customer_id', 'subscription_status')
    .where({ is_active: true })
    .whereIn('subscription_status', ['active', 'trialing'])
    .whereNull('card_required_by');

  console.log(`${PREFIX}Scanning ${drivers.length} active driver(s) with no existing deadline\n`);

  const summary = { stamped: 0, hasCard: 0, errors: 0 };
  for (const d of drivers) {
    try {
      const hasCard = await hasCardOnFile(d.stripe_customer_id);
      if (hasCard) {
        summary.hasCard++;
        continue;
      }

      if (COMMIT) {
        await db('drivers').where({ id: d.id }).update({
          card_required_by: DEADLINE,
          updated_at:       db.fn.now(),
        });
      }
      summary.stamped++;
      console.log(`  ${PREFIX}driver ${d.id} (#${d.vehicle_number}) — no card → deadline ${DEADLINE.toISOString().slice(0, 10)}`);
    } catch (err) {
      summary.errors++;
      console.error(`  ✗ driver ${d.id} (#${d.vehicle_number}) → ${err.message}`);
    }
  }

  console.log(`\n${PREFIX}Summary:`, summary);
  if (!COMMIT) console.log('\nNo writes performed. Re-run with --commit to apply.');
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; })
  .finally(() => db.destroy());
