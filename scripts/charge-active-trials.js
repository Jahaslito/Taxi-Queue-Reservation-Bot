'use strict';

// One-off: charge everyone who is currently on a FREE TRIAL, right now.
// SELF-CONTAINED: needs only the `stripe` package + STRIPE_SECRET_KEY in env.
// No DB — driver identity is read from the Stripe customer (email + metadata).
// Safe to drop into a container's /tmp (or run committed) without deploying app
// changes:  docker compose exec app node scripts/charge-active-trials.js
//
// Background: we turned off the free trial (TRIAL_PERIOD_DAYS=0 — new sign-ups
// are charged at Checkout). This script closes the loop for drivers who were
// ALREADY mid-trial: it ends each trialing subscription immediately, which makes
// Stripe finalize the first real invoice and auto-charge the card on file.
//   • charge succeeds → invoice.payment_succeeded webhook → status `active`.
//   • charge declines / insufficient funds → invoice.payment_failed webhook →
//     status `past_due` → the driver is locked out and shown the resubscribe /
//     "Add Card & Pay Now" screen (existing failed-payment flow — nothing extra
//     to do here).
//
// Ending a trial only auto-charges if the subscription/customer has a DEFAULT
// payment method. Some customers have a card ATTACHED but not promoted to
// default (the same gap that caused the "free month" leak). So before ending a
// trial we promote the attached card to default; a customer with no card at all
// is skipped + reported (they'll fall to past_due on their own, as intended).
//
// ─── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/charge-active-trials.js
//       → DRY-RUN. List every trialing subscription + the card that would be
//         charged and the amount. No writes.
//   node scripts/charge-active-trials.js --charge
//       → End each trial NOW and charge the card on file.
//   node scripts/charge-active-trials.js --charge --skip=cus_ABC,42,foo@bar.com
//       → Exclude customers by id / driver_id / `driver#<id>` / email.

try { require('dotenv').config(); } catch (_) { /* env already provided (container) */ }
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1); }
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const args    = process.argv.slice(2);
const CHARGE  = args.includes('--charge');
const skipArg = args.find((a) => a.startsWith('--skip='));
const SKIP = new Set(
  (skipArg ? skipArg.split('=')[1].split(',') : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean),
);

// Refuse to charge inside an active billing pause — same guard the trial config
// and pause-subscriptions.js honor. Charging now would violate the pause window.
const PAUSE_UNTIL = parseInt(process.env.STRIPE_PAUSE_UNTIL ?? '0', 10);
const NOW_SEC     = Math.floor(Date.now() / 1000);

const money = (cents, ccy = 'usd') => `${(cents / 100).toFixed(2)} ${ccy.toUpperCase()}`;

// Identity straight from the Stripe customer — no DB needed.
function who(customer) {
  if (!customer || typeof customer !== 'object') return '(customer not expanded)';
  if (customer.deleted) return '(deleted customer)';
  const drv = customer.metadata?.driver_id ? `driver#${customer.metadata.driver_id} ` : '';
  return `${drv}${customer.name || '—'} <${customer.email || '—'}>`;
}

function isSkipped(customer) {
  if (!customer || typeof customer !== 'object') return false;
  const did = customer.metadata?.driver_id;
  const tokens = [customer.id, did, did ? `driver#${did}` : null, customer.email]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return tokens.some((t) => SKIP.has(t));
}

// Every subscription currently on a free trial.
async function listTrialingSubscriptions() {
  const out = [];
  let starting_after;
  do {
    const page = await stripe.subscriptions.list({
      status: 'trialing', limit: 100, starting_after, expand: ['data.customer'],
    });
    out.push(...page.data);
    starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (starting_after);
  return out;
}

// Resolve a usable card for a customer. A card can be ATTACHED but not set as
// the default_payment_method — in which case ending the trial would create an
// invoice with nothing to auto-charge. Prefer the default, else the most recent
// attached card, else the legacy default_source.
async function resolveCard(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const defPm = customer.invoice_settings && customer.invoice_settings.default_payment_method;
  const pms   = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 10 });
  const pmId  = defPm || (pms.data[0] && pms.data[0].id) || customer.default_source || null;
  const found = pmId && pms.data.find((p) => p.id === pmId);
  const card  = found ? found.card : null;
  const source = defPm ? 'default' : (pms.data.length ? 'attached (not default)' : (customer.default_source ? 'legacy source' : null));
  return { customer, pmId, card, source, isDefault: !!defPm };
}

(async () => {
  if (Number.isFinite(PAUSE_UNTIL) && PAUSE_UNTIL > NOW_SEC) {
    console.error(`✗ Billing pause active (STRIPE_PAUSE_UNTIL=${PAUSE_UNTIL}, ${new Date(PAUSE_UNTIL * 1000).toISOString()}). Refusing to charge inside the pause window.`);
    process.exit(1);
  }

  console.log(`Charge active trials — ${CHARGE ? 'CHARGE' : 'preview (dry-run)'}.`);
  if (SKIP.size) console.log(`Skip list: ${[...SKIP].join(', ')}`);

  const subs = await listTrialingSubscriptions();
  console.log(`\nFound ${subs.length} trialing subscription(s).${CHARGE ? '' : '  [preview — pass --charge to end trials + charge]'}\n`);

  const summary = { would: 0, charged: 0, collected: 0, failed: 0, noCard: 0, skipped: 0 };

  for (const sub of subs) {
    const customer = sub.customer;
    const customerId = typeof customer === 'string' ? customer : customer.id;
    const label = `${sub.id}  ${who(customer)}`;

    if (isSkipped(customer)) { console.log(`  ⏭ skipped   ${label}  [excluded]`); summary.skipped++; continue; }

    let info;
    try { info = await resolveCard(customerId); }
    catch (err) { console.error(`  ✗ ${label} — card lookup failed: ${err.message}`); summary.failed++; continue; }

    const { pmId, card, source } = info;
    const cardNote = pmId
      ? `${card ? `${card.brand} ••${card.last4}` : pmId} [${source}]`
      : 'NO CARD ON FILE';

    if (!CHARGE) {
      console.log(`  would charge ${label}  ${cardNote}`);
      summary.would++;
      continue;
    }

    if (!pmId) {
      // No card at all → can't charge. Leave the trial to expire on its own; the
      // resulting failed renewal locks them out via the existing flow.
      console.error(`  ⚠ no card   ${label} — cannot charge; trial left to expire → will lock out on its own`);
      summary.noCard++;
      continue;
    }

    try {
      // Promote the resolved card to default so ending the trial has a card to
      // auto-charge AND future renewals collect automatically.
      if (!info.isDefault) {
        await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } });
      }
      // End the trial NOW. Stripe finalizes the first real invoice and attempts
      // payment on the default card. Success → active; decline → past_due (both
      // handled by existing webhooks).
      const updated = await stripe.subscriptions.update(sub.id, { trial_end: 'now' });

      // Report what the immediate invoice did, if we can see it.
      const latestId = typeof updated.latest_invoice === 'string' ? updated.latest_invoice : (updated.latest_invoice && updated.latest_invoice.id);
      let paidNote = `status now ${updated.status}`;
      if (latestId) {
        try {
          const inv = await stripe.invoices.retrieve(latestId);
          paidNote = `invoice ${inv.status}, paid ${money(inv.amount_paid || 0, inv.currency)}`;
          if (inv.status === 'paid' && (inv.amount_paid || 0) > 0) summary.collected += inv.amount_paid;
        } catch (_) { /* best-effort reporting only */ }
      }
      console.log(`  ✓ ended     ${label}  on ${cardNote} — ${paidNote}`);
      summary.charged++;
    } catch (err) {
      console.error(`  ✗ FAILED    ${label} — ${err.message}`);
      summary.failed++;
    }
  }

  console.log('\n── Summary ──');
  if (CHARGE) {
    console.log(`  ended/charged ${summary.charged} (collected ${money(summary.collected)}), failed ${summary.failed}, no-card ${summary.noCard}, skipped ${summary.skipped}`);
    console.log('  Declines & no-card cases flip to past_due via the webhook → locked out + resubscribe screen.');
  } else {
    console.log(`  ${summary.would} would be charged, skipped ${summary.skipped}`);
    console.log('  Preview only — re-run with --charge to end trials and collect.');
  }
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
