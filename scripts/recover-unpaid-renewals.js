'use strict';

// One-off recovery for renewals we failed to collect — the "free month" leak.
// SELF-CONTAINED: needs only the `stripe` package + STRIPE_SECRET_KEY in env.
// No DB — driver identity is read from the Stripe customer (email + metadata).
// Safe to drop into a container's /tmp and run without deploying app changes.
//
// Background: reactivation used to be coupled to "a card appeared" instead of
// "the balance was paid". A driver who updated their card (esp. via the Billing
// Portal) got reactivated while the past_due renewal sat uncollected; dunning
// later voided the abandoned invoice and rolled the cycle forward — a free month
// (e.g. "Jama Ali"). This script claws back what already slipped through, on the
// customer's CURRENT default card.
//
// ─── Two cohorts, two safety levels ──────────────────────────────────────────
//   A) OPEN invoices  — genuinely-owed money Stripe still treats as collectible
//      (finalized, unpaid, not voided). Auto-detected. Charged by --charge.
//
//   B) VOIDED renewals — like Jama, where the unpaid invoice was already voided.
//      A void invoice can't be paid; recovery = a fresh one-off charge. These are
//      NOT auto-detected: pause-subscriptions.js legitimately voids invoices, so
//      charging every void would double-bill paused customers. Cohort B is thus
//      (1) limited to customer ids YOU name via --recover, and (2) preview-only
//      unless you ALSO pass --charge-recover. Verify the list first, then charge.
//
// ─── Usage ───────────────────────────────────────────────────────────────────
//   node recover.js
//       → DRY-RUN. Report cohort A open invoices. No writes.
//   node recover.js --charge
//       → Pay all cohort A open invoices on each customer's default card.
//   node recover.js --recover=cus_ABC,cus_XYZ
//       → Also LIST cohort B customers (no charge — verify them).
//   node recover.js --recover=cus_ABC,cus_XYZ --charge-recover
//       → Charge cohort B (fresh one-off, default = STRIPE_PRICE_ID amount).
//   node recover.js --recover=cus_ABC --amount=1600 --charge-recover
//       → Override the cohort B amount (cents).
//
// --charge and --charge-recover are independent arming switches. Cohort A is
// safe to re-run (paid invoices leave the `open` set). Cohort B is NOT
// idempotent — each --charge-recover run adds a new item; name a customer once.

try { require('dotenv').config(); } catch (_) { /* env already provided (container) */ }
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1); }
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const args           = process.argv.slice(2);
const CHARGE_A       = args.includes('--charge');           // arms cohort A
const CHARGE_B       = args.includes('--charge-recover');   // arms cohort B
const recArg         = args.find((a) => a.startsWith('--recover='));
const amtArg         = args.find((a) => a.startsWith('--amount='));
const RECOVER_IDS    = recArg ? recArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
const AMOUNT_OVERRIDE = amtArg ? parseInt(amtArg.split('=')[1], 10) : null;
const skipArg        = args.find((a) => a.startsWith('--skip='));

// Cohort A exclusions. Each token matches (case-insensitive) a customer's id,
// driver_id, `driver#<id>`, or email. driver#26 (Abdiwali Adan) is excluded by
// default — he must not be charged by this script at all.
const DEFAULT_SKIP = ['26'];
const SKIP = new Set(
  [...DEFAULT_SKIP, ...(skipArg ? skipArg.split('=')[1].split(',') : [])]
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean),
);

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

// Every open (finalized, awaiting-payment) invoice — the collectible-debt state.
async function listOpenInvoices() {
  const out = [];
  let starting_after;
  do {
    const page = await stripe.invoices.list({
      status: 'open', limit: 100, starting_after, expand: ['data.customer'],
    });
    out.push(...page.data);
    starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (starting_after);
  return out;
}

async function resolveRecoverAmount() {
  if (Number.isFinite(AMOUNT_OVERRIDE)) return { amount: AMOUNT_OVERRIDE, currency: 'usd' };
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID not set and no --amount given');
  const price = await stripe.prices.retrieve(priceId);
  if (!price.unit_amount) throw new Error(`Price ${priceId} has no fixed unit_amount — pass --amount=<cents>`);
  return { amount: price.unit_amount, currency: price.currency };
}

// ─── Cohort A: pay open invoices on the default card ─────────────────────────
async function runOpenInvoices(summary) {
  const open = await listOpenInvoices();
  console.log(`\n── Cohort A: open (unpaid) invoices ──`);
  if (open.length === 0) { console.log('  ✓ none — no collectible open invoices.'); return; }
  console.log(`  Found ${open.length} open invoice(s).${CHARGE_A ? '' : '  [preview — pass --charge to collect]'}\n`);

  for (const inv of open) {
    const label = `${inv.id} ${money(inv.amount_due, inv.currency)} (${inv.billing_reason || 'invoice'})  ${who(inv.customer)}`;
    if (isSkipped(inv.customer)) { console.log(`  ⏭ skipped      ${label}  [excluded]`); summary.aSkipped++; continue; }
    if (!CHARGE_A) { console.log(`  would charge  ${label}`); summary.aWould++; continue; }
    try {
      const paid = await stripe.invoices.pay(inv.id); // no PM → customer's current default card
      console.log(`  ✓ charged      ${inv.id} ${money(paid.amount_paid, paid.currency)}  ${who(inv.customer)}`);
      summary.aCharged++; summary.aCollected += paid.amount_paid || 0;
    } catch (err) {
      console.error(`  ✗ FAILED       ${label} — ${err.message}`);
      summary.aFailed++;
    }
  }
}

// ─── Cohort B: named voided-leak customers — preview unless --charge-recover ──
async function runRecover(summary) {
  if (RECOVER_IDS.length === 0) return;
  const { amount, currency } = await resolveRecoverAmount();
  console.log(`\n── Cohort B: ${RECOVER_IDS.length} named customer(s) @ ${money(amount, currency)} each ──`);
  console.log(`  ${CHARGE_B ? 'CHARGING (--charge-recover set).' : 'PREVIEW ONLY — verify, then re-run with --charge-recover to charge.'}\n`);

  for (const customerId of RECOVER_IDS) {
    let customer;
    try { customer = await stripe.customers.retrieve(customerId); }
    catch (err) { console.error(`  ✗ ${customerId} — lookup failed: ${err.message}`); summary.bFailed++; continue; }

    const hasDefault = customer.invoice_settings?.default_payment_method || customer.default_source;
    const cardNote   = hasDefault ? 'card on file' : 'NO DEFAULT CARD';

    if (!CHARGE_B) {
      console.log(`  would charge ${customerId}  ${money(amount, currency)}  ${who(customer)}  [${cardNote}]`);
      summary.bWould++; continue;
    }
    if (!hasDefault) { console.error(`  ✗ ${customerId} — no default payment method — ${who(customer)}`); summary.bFailed++; continue; }
    try {
      await stripe.invoiceItems.create({ customer: customerId, amount, currency, description: 'Uncollected renewal (recovered)' });
      const invoice = await stripe.invoices.create({
        customer: customerId, collection_method: 'charge_automatically', auto_advance: false,
        description: 'Recovery of a renewal that was voided before collection',
      });
      await stripe.invoices.finalizeInvoice(invoice.id);
      const paid = await stripe.invoices.pay(invoice.id);
      console.log(`  ✓ charged ${customerId} ${money(paid.amount_paid, paid.currency)} (${invoice.id})  ${who(customer)}`);
      summary.bCharged++; summary.bCollected += paid.amount_paid || 0;
    } catch (err) {
      console.error(`  ✗ FAILED ${customerId} — ${err.message} — ${who(customer)}`);
      summary.bFailed++;
    }
  }
}

(async () => {
  console.log(`Recover uncollected renewals — cohort A ${CHARGE_A ? 'CHARGE' : 'preview'}, cohort B ${RECOVER_IDS.length ? (CHARGE_B ? 'CHARGE' : 'preview') : 'none'}.`);
  const summary = { aWould: 0, aCharged: 0, aCollected: 0, aFailed: 0, aSkipped: 0, bWould: 0, bCharged: 0, bCollected: 0, bFailed: 0 };
  console.log(`Skip list (excluded from cohort A): ${[...SKIP].join(', ')}`);

  await runOpenInvoices(summary);
  await runRecover(summary);

  console.log('\n── Summary ──');
  console.log(`  Cohort A: ${CHARGE_A ? `charged ${summary.aCharged} (${money(summary.aCollected)}), failed ${summary.aFailed}` : `${summary.aWould} would be charged`}, skipped ${summary.aSkipped}`);
  if (RECOVER_IDS.length) {
    console.log(`  Cohort B: ${CHARGE_B ? `charged ${summary.bCharged} (${money(summary.bCollected)}), failed ${summary.bFailed}` : `${summary.bWould} listed (not charged)`}`);
  }
  if (!CHARGE_A) console.log('\n  Cohort A preview only — re-run with --charge to collect.');
  if (RECOVER_IDS.length && !CHARGE_B) console.log('  Cohort B preview only — re-run with --charge-recover once verified.');
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
