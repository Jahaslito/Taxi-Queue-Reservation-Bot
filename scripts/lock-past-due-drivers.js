#!/usr/bin/env node
/**
 * lock-past-due-drivers.js — lock drivers who owe money / have a dead card.
 *
 * Sets subscription_status='past_due' for the named driver ids. That:
 *   • drops them from the position scheduler (Driver.js gateServiceableStatus
 *     only services active/trialing), and
 *   • makes the app show the "Add Card & Pay Now" card-lock view (past_due branch
 *     in billing.controller.js).
 * is_active is deliberately NOT touched — they must stay able to log in to fix
 * their card. Only drivers currently active/trialing are flipped; anything else
 * (already past_due/canceled) is reported and left alone.
 *
 * --notify emails each newly-locked driver the standard payment-failed email
 * (same one the invoice.payment_failed webhook sends). Emails are sent only in
 * --lock mode — never on a dry-run.
 *
 * Usage:
 *   node scripts/lock-past-due-drivers.js --ids=33,76,9,49                 # dry-run
 *   node scripts/lock-past-due-drivers.js --ids=33,76,9,49 --lock          # apply
 *   node scripts/lock-past-due-drivers.js --ids=33,76,9,49 --lock --notify # apply + email
 */
'use strict';

let db, emailService;
try { db = require('/app/src/config/database'); emailService = require('/app/src/services/emailService'); }
catch (_) { db = require('../src/config/database'); emailService = require('../src/services/emailService'); }

const args   = process.argv.slice(2);
const LOCK   = args.includes('--lock');
const NOTIFY = args.includes('--notify');
const idsArg = args.find((a) => a.startsWith('--ids='));
const IDS = idsArg
  ? idsArg.split('=')[1].split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
  : [];

if (IDS.length === 0) { console.error('✗ pass --ids=<comma-separated driver ids>'); process.exit(1); }

const LOCKABLE = ['active', 'trialing']; // only flip serviceable drivers

(async () => {
  console.log(`${LOCK ? 'LOCK' : '[DRY-RUN]'} — set subscription_status='past_due'${NOTIFY ? ' + notify' : ''} for driver(s): ${IDS.join(', ')}\n`);

  const rows = await db('drivers')
    .whereIn('id', IDS)
    .select('id', 'name', 'email', 'subscription_status', 'is_active', 'stripe_customer_id');

  const found   = new Set(rows.map((r) => r.id));
  const missing = IDS.filter((id) => !found.has(id));
  for (const id of missing) console.log(`  ✗ driver#${id} — not found`);

  const toLock = [];
  for (const r of rows) {
    const tag = `driver#${r.id} ${r.name} <${r.email}>  status=${r.subscription_status || 'none'} is_active=${r.is_active}`;
    if (!LOCKABLE.includes(r.subscription_status)) {
      console.log(`  ⏭ skip   ${tag}  [not active/trialing — already locked or canceled]`);
      continue;
    }
    toLock.push(r);
    console.log(`  ${LOCK ? '→ lock ' : 'would lock'} ${tag}  →  past_due${NOTIFY ? '  (+email)' : ''}`);
  }

  let notified = 0, notifyFailed = 0;
  if (LOCK && toLock.length) {
    const n = await db('drivers')
      .whereIn('id', toLock.map((r) => r.id))
      .update({ subscription_status: 'past_due', updated_at: db.fn.now() });
    console.log(`\n  ✓ updated ${n} driver(s) → past_due`);

    if (NOTIFY) {
      for (const r of toLock) {
        try {
          await emailService.sendPaymentFailedEmail(r);
          console.log(`  ✉  emailed driver#${r.id} <${r.email}>`);
          notified++;
        } catch (err) {
          console.error(`  ✗ email failed driver#${r.id} <${r.email}> — ${err.message}`);
          notifyFailed++;
        }
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  requested ${IDS.length}, found ${rows.length}, ${LOCK ? 'locked' : 'would lock'} ${toLock.length}, missing ${missing.length}`);
  if (LOCK && NOTIFY) console.log(`  emailed ${notified}, email failed ${notifyFailed}`);
  if (!LOCK) console.log('\n  Dry-run only. Re-run with --lock to apply (add --notify to email them).');
})()
  .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; })
  .finally(() => db.destroy());
