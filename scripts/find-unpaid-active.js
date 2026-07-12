#!/usr/bin/env node
/**
 * find-unpaid-active.js — READ-ONLY. Find drivers who look fine but didn't pay.
 *
 * The "free month" fingerprint (e.g. Jama Ali, Ali Adde): the subscription is
 * ACTIVE with a future next-invoice date, yet a renewal invoice was voided /
 * marked uncollectible and never collected — the app services them for free.
 *
 * Detection: subscriptions currently active/trialing that have a void or
 * uncollectible invoice with amount_paid = 0 and a real amount due.
 *
 * Each hit is annotated:
 *   [charge attempted → <pi status> → LIKELY LEAK]  — a PaymentIntent exists, so
 *       a charge was tried and failed/canceled (dunning / card issue). Real debt.
 *   [no charge attempted → possibly pause-void]      — no PaymentIntent; likely a
 *       legitimate pause_collection='void' from pause-subscriptions.js. Verify
 *       before treating as owed.
 *
 * No writes, no charges — safe to run any time. To collect, use
 * recover-unpaid-renewals.js (cohort B) with the customer ids this prints.
 *
 * Usage:  node scripts/find-unpaid-active.js
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* env already in container */ }

let Stripe;
try { Stripe = require('stripe'); }
catch (_) { Stripe = require('/app/node_modules/stripe'); }

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1); }
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const ACTIVE  = ['active', 'trialing'];
const money   = (c, ccy = 'usd') => `${(c / 100).toFixed(2)} ${ccy.toUpperCase()}`;
const fmtDate = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');

function who(c) {
  if (!c || typeof c !== 'object') return '(customer not expanded)';
  if (c.deleted) return '(deleted customer)';
  const d = c.metadata && c.metadata.driver_id ? `driver#${c.metadata.driver_id} ` : '';
  return `${d}${c.name || '—'} <${c.email || '—'}>`;
}

async function listInvoicesByStatus(status) {
  const out = [];
  let starting_after;
  do {
    const page = await stripe.invoices.list({
      status, limit: 100, starting_after,
      expand: ['data.customer', 'data.subscription', 'data.payment_intent'],
    });
    out.push(...page.data);
    starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (starting_after);
  return out;
}

(async () => {
  console.log('Scanning for ACTIVE subscriptions with UNCOLLECTED (void/uncollectible) invoices…\n');

  const invoices = [
    ...await listInvoicesByStatus('void'),
    ...await listInvoicesByStatus('uncollectible'),
  ];

  const leaks = invoices.filter((inv) => {
    const sub = inv.subscription;
    const subActive = sub && typeof sub === 'object' && ACTIVE.includes(sub.status);
    return subActive && (inv.amount_paid || 0) === 0 && (inv.total || 0) > 0;
  });

  const byCust = new Map();
  for (const inv of leaks) {
    const cid = typeof inv.customer === 'object' ? inv.customer.id : inv.customer;
    const g = byCust.get(cid) || { customer: inv.customer, sub: inv.subscription, invoices: [] };
    g.invoices.push(inv);
    byCust.set(cid, g);
  }

  if (byCust.size === 0) {
    console.log('✓ none — no active subscriptions with uncollected invoices.');
    return;
  }

  let grand = 0, attempted = 0, drivers = 0;
  for (const [cid, g] of byCust) {
    const total = g.invoices.reduce((s, i) => s + (i.total || 0), 0);
    grand += total; drivers++;
    const sub = g.sub;
    console.log(`${cid}  ${who(g.customer)}  sub=${sub ? sub.status : '?'} next=${sub ? fmtDate(sub.current_period_end) : '—'}  uncollected=${money(total)}`);
    for (const inv of g.invoices) {
      const pi = inv.payment_intent;
      const tried = pi && typeof pi === 'object';
      if (tried) attempted += inv.total || 0;
      const when = fmtDate((inv.status_transitions && inv.status_transitions.voided_at) || inv.created);
      const note = tried
        ? `[charge attempted → ${pi.status} → LIKELY LEAK]`
        : `[no charge attempted → possibly pause-void, verify]`;
      console.log(`    ✗ ${inv.id}  ${money(inv.total, inv.currency)}  ${inv.status}  ${when}  ${inv.billing_reason || 'invoice'}  ${note}`);
    }
  }

  console.log('\n── Summary ──');
  console.log(`  ${drivers} active driver(s) with uncollected invoices — total ${money(grand)}.`);
  console.log(`  Of that, ${money(attempted)} had a real charge attempt (a PaymentIntent) → the genuine leak.`);
  console.log('  The rest (no charge attempted) may be legitimate billing-pause voids — verify before charging.');
  console.log('  To collect a genuine one: recover-unpaid-renewals.js --recover=<cus_id> --charge-recover');
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
