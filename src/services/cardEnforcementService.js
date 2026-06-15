// ─── Card Enforcement Service ─────────────────────────────────────────────────
// Deactivates grandfathered drivers who were asked to add a card on file but
// let their grace window lapse.
//
// The cohort is stamped with `card_required_by` by scripts/backfill-card-required.js
// (computed against Stripe truth — having a Stripe customer is NOT the same as
// having a card). During the grace window the dashboard shows a persistent
// "add your card" banner but access is unchanged. Once the deadline passes this
// sweep deactivates them:
//   • is_active = false           → stops the bot from servicing them (the
//                                    scheduler/monitor only ever load is_active
//                                    drivers) and shows them as inactive to admin
//   • subscription_status = past_due → drives the "failed subscription, add a
//                                    card to reactivate" billing screen
//
// Deactivation here is self-healable: auth lets a driver carrying a
// card_required_by stamp log back in (see middleware/auth.js) so they can reach
// checkout, and the Stripe webhook flips is_active back to true + clears the
// stamp the moment a card is confirmed.
//
// Set BILLING_ENABLED=false to disable enforcement entirely (matches the rest of
// the billing gates).

const cron   = require('node-cron');
const Driver = require('../models/Driver');

const BILLING_ENABLED = process.env.BILLING_ENABLED !== 'false';

/**
 * One enforcement pass. Exported for manual runs / tests.
 * @returns {Promise<number>} number of drivers deactivated
 */
async function runCardEnforcement() {
  if (!BILLING_ENABLED) return 0;

  const due = await Driver.findCardEnforcementDue();
  if (!due.length) return 0;

  let deactivated = 0;
  for (const driver of due) {
    try {
      await Driver.update(driver.id, {
        is_active:           false,
        subscription_status: 'past_due',
      });
      deactivated++;
      console.log(
        `[CardEnforcement] Deactivated driver ${driver.id} (#${driver.vehicle_number}) — ` +
        `card grace expired ${new Date(driver.card_required_by).toISOString()}`,
      );
    } catch (err) {
      console.error(`[CardEnforcement] Failed to deactivate driver ${driver.id}:`, err.message);
    }
  }

  if (deactivated) {
    console.log(`[CardEnforcement] Sweep complete — ${deactivated} driver(s) deactivated`);
  }
  return deactivated;
}

/**
 * Register the hourly sweep. The deadline is an absolute timestamp so the run
 * cadence only affects how promptly a lapsed driver is deactivated, not who.
 */
function startCardEnforcement() {
  if (!BILLING_ENABLED) {
    console.log('[CardEnforcement] BILLING_ENABLED=false — enforcement disabled');
    return;
  }

  // Run once at boot (catches anyone who lapsed while the server was down),
  // then every hour on the hour.
  runCardEnforcement().catch((err) => console.error('[CardEnforcement] Boot sweep failed:', err.message));
  cron.schedule('0 * * * *', () => {
    runCardEnforcement().catch((err) => console.error('[CardEnforcement] Sweep failed:', err.message));
  });
  console.log('[CardEnforcement] Hourly card-on-file enforcement started');
}

module.exports = { startCardEnforcement, runCardEnforcement };
