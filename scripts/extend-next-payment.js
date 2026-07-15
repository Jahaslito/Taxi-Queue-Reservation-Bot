'use strict';

// Interactive: push selected drivers' NEXT PAYMENT out by N days (default 14),
// free-trial style — the driver keeps full access, pays nothing during the
// extension, then Stripe auto-charges the card on file when it ends.
//
// How: set `trial_end = <current next-payment date> + N days` on the Stripe
// subscription (proration_behavior: 'none' → no credit notes). Stripe flips the
// sub to `trialing` until then; `trialing` is in SERVICEABLE_STATUSES, so the
// bot keeps servicing the driver throughout. At trial end Stripe finalizes the
// next invoice and charges the default card — success → active, decline →
// past_due → existing failed-payment lockout flow. The
// customer.subscription.updated webhook syncs subscription_status +
// trial_ends_at to the drivers table, so this script never writes the DB.
//
// Auto-charge at trial end needs a DEFAULT payment method. Like
// charge-active-trials.js, a card attached but not default is promoted to
// default on apply; a driver with no card at all still gets the extension but
// is flagged (they'll fall to past_due at trial end unless they add a card).
//
// ─── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/extend-next-payment.js
//       → Step 1: prompts for driver email(s), comma/space separated.
//       → Step 2: previews each driver (current → new payment date, card).
//       → Step 3: asks for confirmation, then applies.
//   node scripts/extend-next-payment.js foo@bar.com baz@qux.com
//       → Same, but skips the email prompt.
//   node scripts/extend-next-payment.js --days=30
//       → Extend by 30 days instead of 14.
//
// Skipped (never touched): driver not found, no subscription on file, sub
// canceled (must resubscribe), sub past_due (extension wouldn't void the open
// invoice — use the existing recovery flow first).

require('dotenv').config();
const readline = require('readline');
const db       = require('../src/config/database');
const Stripe   = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1); }
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const args    = process.argv.slice(2);
const daysArg = args.find((a) => a.startsWith('--days='));
const DAYS    = daysArg ? parseInt(daysArg.split('=')[1], 10) : 14;
const ARG_EMAILS = args.filter((a) => !a.startsWith('--'));

if (!Number.isInteger(DAYS) || DAYS < 1) {
  console.error(`✗ --days must be a positive integer (got "${daysArg}")`); process.exit(1);
}

const DAY_SEC = 24 * 60 * 60;
const NOW_SEC = Math.floor(Date.now() / 1000);

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// Show dates the way deploy notes are written — PT, plus the raw ISO.
function fmt(sec) {
  const d = new Date(sec * 1000);
  const pt = d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `${pt} PT (${d.toISOString().slice(0, 10)})`;
}

// Same card resolution as charge-active-trials.js: prefer the default PM, else
// the most recent attached card. Without a default, the post-trial invoice has
// nothing to auto-charge.
async function resolveCard(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return { pmId: null, card: null, isDefault: false };
  const defPm = customer.invoice_settings && customer.invoice_settings.default_payment_method;
  const pms   = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 10 });
  const pmId  = defPm || (pms.data[0] && pms.data[0].id) || null;
  const found = pmId && pms.data.find((p) => p.id === pmId);
  return { pmId, card: found ? found.card : null, isDefault: !!defPm };
}

// Resolve one email → a plan (what we'd do) or a skip (why we won't).
async function buildPlan(email) {
  const driver = await db('drivers')
    .select('id', 'name', 'email', 'stripe_customer_id', 'stripe_subscription_id', 'subscription_status')
    .whereRaw('LOWER(email) = ?', [email])
    .first();

  if (!driver) return { email, skip: 'no driver with this email' };
  const label = `driver#${driver.id} ${driver.name || '—'} <${driver.email}>`;

  if (!driver.stripe_subscription_id) return { email, label, skip: 'no subscription on file' };

  let sub;
  try { sub = await stripe.subscriptions.retrieve(driver.stripe_subscription_id); }
  catch (err) { return { email, label, skip: `Stripe lookup failed: ${err.message}` }; }

  if (sub.status === 'canceled') return { email, label, skip: 'subscription canceled — driver must resubscribe' };
  if (sub.status === 'past_due' || sub.status === 'unpaid') {
    return { email, label, skip: `subscription ${sub.status} — clear the open invoice first (extension would not void it)` };
  }

  // Next payment date: for a trialing sub that's the trial end; otherwise the
  // current period end. Never anchor in the past.
  const base = (sub.status === 'trialing' && sub.trial_end)
    ? sub.trial_end
    : (sub.current_period_end || NOW_SEC);
  const newTrialEnd = Math.max(base, NOW_SEC) + DAYS * DAY_SEC;

  const warnings = [];
  if (sub.cancel_at_period_end) {
    warnings.push('cancellation is scheduled — this delays the cancel date; the driver will NOT be charged at the end');
  }

  let cardInfo;
  try { cardInfo = await resolveCard(sub.customer); }
  catch (err) { cardInfo = { pmId: null, card: null, isDefault: false }; warnings.push(`card lookup failed: ${err.message}`); }
  if (!cardInfo.pmId) warnings.push('NO CARD ON FILE — will go past_due at the end unless a card is added');

  return { email, label, driver, sub, base, newTrialEnd, cardInfo, warnings };
}

(async () => {
  console.log(`Extend next payment by ${DAYS} days (free-trial style, auto-charge at the end)\n`);

  // ─── Step 1: which drivers? ────────────────────────────────────────────────
  let raw = ARG_EMAILS.join(' ');
  if (!raw.trim()) {
    raw = await ask('Driver email(s), comma or space separated: ');
  }
  const emails = [...new Set(
    raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
  )];
  if (emails.length === 0) { console.log('No emails given — nothing to do.'); return; }

  // ─── Step 2: resolve + preview ─────────────────────────────────────────────
  console.log(`\nLooking up ${emails.length} driver(s)…\n`);
  const plans = [];
  for (const email of emails) plans.push(await buildPlan(email));

  const actionable = plans.filter((p) => !p.skip);
  for (const p of plans) {
    if (p.skip) { console.log(`  ⏭ skip      ${p.label || p.email} — ${p.skip}`); continue; }
    const { card, pmId, isDefault } = p.cardInfo;
    const cardNote = pmId
      ? `${card ? `${card.brand} ••${card.last4}` : pmId}${isDefault ? '' : ' (will promote to default)'}`
      : 'NO CARD';
    console.log(`  → ${p.label}`);
    console.log(`      status ${p.sub.status} — next payment ${fmt(p.base)}  ⇒  ${fmt(p.newTrialEnd)}  on ${cardNote}`);
    for (const w of p.warnings) console.log(`      ⚠ ${w}`);
  }

  if (actionable.length === 0) { console.log('\nNothing actionable — no changes made.'); return; }

  // ─── Step 3: confirm + apply ───────────────────────────────────────────────
  const answer = (await ask(`\nApply to ${actionable.length} driver(s)? Type "yes" to proceed: `)).trim().toLowerCase();
  if (answer !== 'yes') { console.log('Aborted — no changes made.'); return; }

  console.log('');
  const summary = { extended: 0, failed: 0, skipped: plans.length - actionable.length };
  for (const p of actionable) {
    try {
      // Promote an attached-but-not-default card so the post-trial invoice
      // auto-charges (and future renewals collect without intervention).
      if (p.cardInfo.pmId && !p.cardInfo.isDefault) {
        await stripe.customers.update(p.sub.customer, {
          invoice_settings: { default_payment_method: p.cardInfo.pmId },
        });
      }
      const updated = await stripe.subscriptions.update(p.sub.id, {
        trial_end:          p.newTrialEnd,
        proration_behavior: 'none',
      });
      console.log(`  ✓ extended  ${p.label} — status ${updated.status}, charges ${fmt(p.newTrialEnd)}`);
      summary.extended++;
    } catch (err) {
      console.error(`  ✗ FAILED    ${p.label} — ${err.message}`);
      summary.failed++;
    }
  }

  console.log('\n── Summary ──');
  console.log(`  extended ${summary.extended}, failed ${summary.failed}, skipped ${summary.skipped}`);
  console.log('  The subscription.updated webhook syncs status (trialing) + trial_ends_at to the DB;');
  console.log('  trialing is serviceable, so drivers keep bot service through the extension.');
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; })
  .finally(async () => { rl.close(); await db.destroy(); });
