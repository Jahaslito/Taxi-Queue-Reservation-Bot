'use strict';

// One-shot pauser/resumer for ALL active+trialing Stripe subscriptions.
//
// Usage:
//   node scripts/pause-subscriptions.js --dry-run        ← preview, no writes
//   node scripts/pause-subscriptions.js                  ← pause for 21 days
//   node scripts/pause-subscriptions.js --days=14        ← pause for 14 days
//   node scripts/pause-subscriptions.js --resume         ← clear pauses
//
// Behaviour: pause_collection.behavior = 'void' — Stripe voids invoices that
// would have been generated during the pause, so no charge attempts happen.
// resumes_at is a hard deadline; Stripe auto-resumes billing at that timestamp
// without us having to remember to flip it back.
//
// Idempotent: re-running re-applies the same pause to anything new and skips
// already-paused subs with matching resumes_at (logged as "skip: already paused").

require('dotenv').config();
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('✗ STRIPE_SECRET_KEY is not set'); process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: '2024-04-10' });

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const RESUME    = args.includes('--resume');
const daysArg   = args.find((a) => a.startsWith('--days='));
const DAYS      = daysArg ? parseInt(daysArg.split('=')[1], 10) : 21;

const RESUMES_AT = Math.floor(Date.now() / 1000) + DAYS * 24 * 60 * 60;
const RESUMES_AT_HUMAN = new Date(RESUMES_AT * 1000).toISOString();

const PREFIX = DRY_RUN ? '[DRY-RUN] ' : '';

async function listAllSubscriptions() {
  // Pull active + trialing in separate calls — clearer than the 'all' filter.
  const out = [];
  for (const status of ['active', 'trialing']) {
    let starting_after;
    do {
      const page = await stripe.subscriptions.list({
        status, limit: 100, starting_after,
      });
      out.push(...page.data);
      starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
    } while (starting_after);
  }
  return out;
}

async function pauseOne(sub) {
  const existing = sub.pause_collection;
  if (existing && existing.resumes_at === RESUMES_AT && existing.behavior === 'void') {
    return { id: sub.id, action: 'skip: already paused with same resumes_at' };
  }
  if (DRY_RUN) {
    return { id: sub.id, action: `would pause (status=${sub.status}, customer=${sub.customer})` };
  }
  const updated = await stripe.subscriptions.update(sub.id, {
    pause_collection: { behavior: 'void', resumes_at: RESUMES_AT },
  });
  return { id: sub.id, action: `paused until ${RESUMES_AT_HUMAN} (was ${sub.status})`, status: updated.status };
}

async function resumeOne(sub) {
  if (!sub.pause_collection) {
    return { id: sub.id, action: 'skip: not paused' };
  }
  if (DRY_RUN) {
    return { id: sub.id, action: 'would resume' };
  }
  // Clearing pause_collection by setting it to '' (Stripe's documented unset).
  const updated = await stripe.subscriptions.update(sub.id, { pause_collection: '' });
  return { id: sub.id, action: `resumed (status=${updated.status})` };
}

(async () => {
  const mode = RESUME ? 'RESUME' : 'PAUSE';
  console.log(`${PREFIX}${mode}: scanning all active + trialing subscriptions…`);
  if (!RESUME) console.log(`${PREFIX}Target pause window: ${DAYS} days → resumes ${RESUMES_AT_HUMAN}`);

  const subs = await listAllSubscriptions();
  console.log(`${PREFIX}Found ${subs.length} subscription(s)\n`);

  if (subs.length === 0) {
    console.log('Nothing to do.'); return;
  }

  // Process serially — no need to hammer Stripe and it keeps the log readable.
  const summary = { paused: 0, resumed: 0, skipped: 0, errors: 0 };
  for (const sub of subs) {
    try {
      const result = RESUME ? await resumeOne(sub) : await pauseOne(sub);
      console.log(`  ${PREFIX}${result.id} → ${result.action}`);
      if (result.action.startsWith('skip')) summary.skipped++;
      else if (RESUME) summary.resumed++;
      else summary.paused++;
    } catch (err) {
      console.error(`  ✗ ${sub.id} → ${err.message}`);
      summary.errors++;
    }
  }

  console.log(`\n${PREFIX}Summary:`, summary);
  if (DRY_RUN) console.log('\nNo writes performed. Re-run without --dry-run to apply.');

  // ─── Sync the new-signup behavior ────────────────────────────────────────
  // Existing subs are paused via pause_collection. New drivers who sign up
  // during the window are handled in stripeService.createCheckoutSession,
  // which reads STRIPE_PAUSE_UNTIL and extends their trial to clear the
  // window. Print the exact env value so the two pieces stay in sync — set
  // this on your server, then run the script again with --resume + clear
  // the env var when you want to lift the pause.
  if (!RESUME) {
    console.log('\n── Sync to new sign-ups ──');
    console.log('  Set this env var on the app so new drivers signing up during the');
    console.log('  pause window get their trial extended past the pause-end:');
    console.log('');
    console.log(`    STRIPE_PAUSE_UNTIL=${RESUMES_AT}    # ${RESUMES_AT_HUMAN}`);
    console.log('');
    console.log('  When lifting the pause early: re-run with --resume AND unset the env var.');
  } else {
    console.log('\n── Sync to new sign-ups ──');
    console.log('  Remember to also unset STRIPE_PAUSE_UNTIL on the app so new drivers get');
    console.log('  the default 14-day trial instead of an extended one.');
  }
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
