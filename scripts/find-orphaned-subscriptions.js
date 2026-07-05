'use strict';

// One-off audit: find Stripe subscriptions that are still billable but no longer
// belong to any driver in our database — i.e. orphans left behind by past hard
// deletes (before delete started cancelling billing). Optionally winds them down.
//
// A subscription is "orphaned" when NEITHER its id nor its customer id is
// referenced by any row in the drivers table.
//
// Usage:
//   node scripts/find-orphaned-subscriptions.js            ← report only (no writes)
//   node scripts/find-orphaned-subscriptions.js --cancel   ← schedule cancel_at_period_end on each orphan
//
// Read-only by default. --cancel never charges: it sets cancel_at_period_end so
// each orphan stops renewing at the end of its current period.

require('dotenv').config();
const db     = require('../src/config/database');
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const CANCEL = process.argv.slice(2).includes('--cancel');

// Statuses that can still generate charges — the ones worth auditing. 'canceled'
// and 'incomplete_expired' are terminal and never bill again, so we skip them.
const BILLABLE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

async function listBillableSubscriptions() {
  const out = [];
  for (const status of BILLABLE_STATUSES) {
    let starting_after;
    do {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        starting_after,
        expand: ['data.customer'], // pull customer so we can show email
      });
      out.push(...page.data);
      starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
    } while (starting_after);
  }
  return out;
}

function fmtDate(epochSec) {
  return epochSec ? new Date(epochSec * 1000).toISOString().slice(0, 10) : '—';
}

function customerEmail(sub) {
  const c = sub.customer;
  if (c && typeof c === 'object') return c.email || (c.deleted ? '(deleted customer)' : '—');
  return '—';
}

(async () => {
  console.log(`Scanning Stripe for billable subscriptions (${BILLABLE_STATUSES.join(', ')})…`);

  // Build the set of subscription + customer ids still referenced by a driver.
  const rows = await db('drivers')
    .whereNotNull('stripe_subscription_id')
    .orWhereNotNull('stripe_customer_id')
    .select('stripe_subscription_id', 'stripe_customer_id');

  const knownSubs = new Set(rows.map((r) => r.stripe_subscription_id).filter(Boolean));
  const knownCustomers = new Set(rows.map((r) => r.stripe_customer_id).filter(Boolean));
  console.log(`DB references ${knownSubs.size} subscription id(s) and ${knownCustomers.size} customer id(s).`);

  const subs = await listBillableSubscriptions();
  console.log(`Found ${subs.length} billable subscription(s) in Stripe.\n`);

  const orphans = subs.filter((sub) => {
    const custId = typeof sub.customer === 'object' ? sub.customer.id : sub.customer;
    return !knownSubs.has(sub.id) && !knownCustomers.has(custId);
  });

  if (orphans.length === 0) {
    console.log('✓ No orphaned subscriptions — every billable subscription maps to a driver.');
    return;
  }

  console.log(`⚠ ${orphans.length} orphaned subscription(s) (no matching driver):\n`);
  for (const sub of orphans) {
    const custId = typeof sub.customer === 'object' ? sub.customer.id : sub.customer;
    const alreadyCancelling = sub.cancel_at_period_end ? ' [already set to cancel]' : '';
    console.log(
      `  ${sub.id}  status=${sub.status}  renews=${fmtDate(sub.current_period_end)}  ` +
      `customer=${custId}  email=${customerEmail(sub)}${alreadyCancelling}`,
    );
  }

  if (!CANCEL) {
    console.log('\nRead-only run. Re-run with --cancel to schedule cancel_at_period_end on each orphan.');
    return;
  }

  console.log('\n--cancel: scheduling cancel_at_period_end on each orphan…');
  const summary = { cancelled: 0, skipped: 0, errors: 0 };
  for (const sub of orphans) {
    try {
      if (sub.cancel_at_period_end) {
        console.log(`  skip  ${sub.id} — already scheduled to cancel`);
        summary.skipped++;
        continue;
      }
      await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      console.log(`  ✓ ${sub.id} — will cancel at ${fmtDate(sub.current_period_end)}`);
      summary.cancelled++;
    } catch (err) {
      console.error(`  ✗ ${sub.id} — ${err.message}`);
      summary.errors++;
    }
  }
  console.log('\nSummary:', summary);
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; })
  .finally(() => db.destroy());
