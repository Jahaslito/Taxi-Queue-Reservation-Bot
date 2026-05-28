'use strict';

// ─── Session warmer ──────────────────────────────────────────────────────────
//
// Pre-logs scheduled drivers into SAN before the morning queue surge so the
// real fire skips the 15-25 s OIDC login and runs in ~5 s. Direct response
// to the position-scheduling analysis on 2026-05-26 and 2026-05-27 logs:
// drift over-prediction was tracking bot execution time, and bot execution
// time was dominated by login.
//
// Selection: only drivers who are active, not in credential lockout, and
// have a schedule (position or time) for *today* in Pacific Time. Inactive
// drivers and days-off are skipped to keep the warm budget proportional to
// real usage as the fleet scales.
//
// Concurrency: capped at WARMER_CONCURRENCY with a per-start delay so we
// don't recreate the 05:00 dogpile against SAN's IdentityServer.
//
// Schedules:
//   Morning warm (default 03:00 PT) — warms every scheduled driver, fresh
//     or not. Catches credential failures before the schedule fires.
//   Refresh warms (default every 3 h during ops) — only drivers whose cached
//     session is older than WARMER_FRESH_MS. Logs prove sessions outlive
//     4 h 51 min of dormancy, so a 2 h freshness window is conservative.
//
// Why a separate service: keeps the warming policy (when, who, how often)
// out of botService, which stays purely "do one SAN action."

const cron                = require('node-cron');
const Driver              = require('../models/Driver');
const { decrypt }         = require('./cryptoService');
const { warmSession, sessionStore } = require('./botService');
const credentialLockout   = require('./credentialLockoutService');

// ─── Configuration (env-overridable for tests and ops tuning) ────────────────
const ENABLED          = process.env.WARMER_ENABLED !== 'false';
const MORNING_CRON     = process.env.WARMER_MORNING_CRON  ?? '0 3 * * *';     // 03:00 PT
const REFRESH_CRON     = process.env.WARMER_REFRESH_CRON  ?? '0 6,9,12,15,18,21 * * *';
const CONCURRENCY      = parseInt(process.env.WARMER_CONCURRENCY ?? '2', 10);
const STAGGER_MS       = parseInt(process.env.WARMER_STAGGER_MS  ?? '1000', 10);
// Refresh skips drivers whose cached session is younger than this — avoids
// hammering SAN with logins that don't gain us anything. Floor at 30 min so
// in tests we can drop it without going pathologically low.
const FRESH_MS         = Math.max(
  30 * 60 * 1000,
  parseInt(process.env.WARMER_FRESH_MS ?? String(2 * 60 * 60 * 1000), 10),
);

const DAY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };

function todayDayKeyPT() {
  const dayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Los_Angeles',
  });
  return DAY_MAP[dayStr];
}

// ─── Schedule predicate ──────────────────────────────────────────────────────
// Mirror the same logic monitor + scheduler use to decide whether to ACT on a
// driver today, so the warmer's coverage matches actual bot-fire coverage.
function hasScheduleForToday(driver, dayKey) {
  // Position-schedule (per-day JSON wins over the always-on field)
  if (driver.day_positions) {
    try {
      const dp = JSON.parse(driver.day_positions);
      if (dp[dayKey] !== null && dp[dayKey] !== undefined) return true;
    } catch { /* fall through */ }
  } else if (driver.scheduled_position) {
    return true;
  }

  // Time-schedule (per-day JSON wins over the legacy fields)
  if (driver.day_schedules) {
    try {
      const ds = JSON.parse(driver.day_schedules);
      if (ds[dayKey]) return true;
    } catch { /* fall through */ }
  } else if (driver.scheduled_time) {
    const days = (driver.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
    if (days.includes(dayKey)) return true;
  }

  return false;
}

// ─── Pure selection predicate — exported so tests can hit it directly ────────
// Returns the array of drivers that should be warmed. `mode` toggles the
// freshness gate so morning warms hit everyone and refreshes skip fresh ones.
//
// Injectable deps (isLockedOut, getSessionSavedAt) keep this pure for tests
// without forcing the caller to monkey-patch the credentialLockout / sessionStore
// singletons.
function selectDriversToWarm(drivers, {
  dayKey  = todayDayKeyPT(),
  mode    = 'refresh',  // 'morning' or 'refresh'
  now     = Date.now(),
  freshMs = FRESH_MS,
  isLockedOut      = credentialLockout.isLockedOut,
  getSessionSavedAt = (username) => sessionStore.get(username)?.savedAt ?? null,
} = {}) {
  return drivers.filter((driver) => {
    if (!driver.is_active) return false;
    if (isLockedOut(driver.id)) return false;
    if (!driver.san_username || !driver.san_password) return false;
    if (!hasScheduleForToday(driver, dayKey)) return false;

    // Morning mode warms everyone. warmSession() returns 'reused' cheaply if
    // the cached session is still valid, and the round-trip surfaces stale
    // credentials BEFORE the schedule fires for real.
    if (mode === 'morning') return true;

    // Refresh mode: skip drivers whose cached session is younger than freshMs.
    const savedAt = getSessionSavedAt(driver.san_username);
    if (savedAt === null) return true;        // no cache → warm
    return (now - savedAt) >= freshMs;        // stale enough → warm
  });
}

// ─── Concurrency + stagger control ───────────────────────────────────────────
// Tiny in-house limiter. We don't reuse the bot JobQueue (in monitorService)
// because that one is request-time and shouldn't be blocked by warming.
async function runWithStagger(tasks, concurrency, staggerMs) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      results[idx] = await tasks[idx]();
      if (cursor < tasks.length && staggerMs > 0) {
        await new Promise(r => setTimeout(r, staggerMs));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return results;
}

// ─── One warming pass — exported for tests / manual triggers ─────────────────
// Returns aggregate counts: { mode, selected, warmed, reused, failed, lockedOut }
async function runWarming({ mode = 'refresh' } = {}) {
  if (!ENABLED) {
    console.log('[Warmer] Disabled via WARMER_ENABLED=false — skipping');
    return { mode, selected: 0, warmed: 0, reused: 0, failed: 0, lockedOut: 0, skipped: 0 };
  }

  const startedAt = Date.now();
  const allDrivers = await Driver.findAllActive();
  const dayKey     = todayDayKeyPT();
  const targets    = selectDriversToWarm(allDrivers, { dayKey, mode });

  if (!targets.length) {
    console.log(`[Warmer] ${mode}: no drivers need warming (active=${allDrivers.length}, day=${dayKey})`);
    return { mode, selected: 0, warmed: 0, reused: 0, failed: 0, lockedOut: 0, skipped: 0 };
  }

  console.log(`[Warmer] ${mode}: warming ${targets.length}/${allDrivers.length} active driver(s) — concurrency=${CONCURRENCY}, stagger=${STAGGER_MS}ms`);

  const tasks = targets.map((driver) => async () => {
    let sanPassword;
    try {
      sanPassword = decrypt(driver.san_password);
    } catch (err) {
      console.error(`[Warmer] ${driver.vehicle_number} → could not decrypt password: ${err.message}`);
      return { driverId: driver.id, vehicleNumber: driver.vehicle_number, success: false, error: 'decrypt_failed' };
    }

    const result = await warmSession({
      sanUsername:   driver.san_username,
      sanPassword,
      vehicleNumber: driver.vehicle_number,
    });

    // Arm the credential breaker before the morning's real fires hit — it's
    // exactly the failure case the breaker was designed for, just detected
    // earlier in the day.
    if (!result.success && credentialLockout.isCredentialError(result.rawError || result.error)) {
      credentialLockout.lockOut(driver.id, `warmer: ${result.error}`);
    }

    return { driverId: driver.id, vehicleNumber: driver.vehicle_number, ...result };
  });

  const results = await runWithStagger(tasks, CONCURRENCY, STAGGER_MS);

  const summary = results.reduce((acc, r) => {
    if (r.success && r.reused) acc.reused++;
    else if (r.success)        acc.warmed++;
    else                       acc.failed++;
    return acc;
  }, { warmed: 0, reused: 0, failed: 0 });

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Warmer] ${mode} complete in ${(elapsedMs / 1000).toFixed(1)}s — ` +
    `warmed: ${summary.warmed}, reused: ${summary.reused}, failed: ${summary.failed}`,
  );

  return {
    mode,
    selected: targets.length,
    lockedOut: allDrivers.filter((d) => credentialLockout.isLockedOut(d.id)).length,
    skipped:  allDrivers.length - targets.length,
    elapsedMs,
    ...summary,
  };
}

// ─── Cron registration ───────────────────────────────────────────────────────
let morningJob = null;
let refreshJob = null;

function startSessionWarmer() {
  if (!ENABLED) {
    console.log('[Warmer] Disabled via WARMER_ENABLED=false — not registering crons');
    return;
  }

  if (morningJob) morningJob.stop();
  if (refreshJob) refreshJob.stop();

  morningJob = cron.schedule(MORNING_CRON, () => {
    runWarming({ mode: 'morning' }).catch((err) =>
      console.error('[Warmer] Morning warm failed:', err.message),
    );
  }, { timezone: 'America/Los_Angeles' });

  refreshJob = cron.schedule(REFRESH_CRON, () => {
    runWarming({ mode: 'refresh' }).catch((err) =>
      console.error('[Warmer] Refresh warm failed:', err.message),
    );
  }, { timezone: 'America/Los_Angeles' });

  console.log(
    `[Warmer] Started — morning '${MORNING_CRON}' / refresh '${REFRESH_CRON}' PT ` +
    `(concurrency=${CONCURRENCY}, stagger=${STAGGER_MS}ms, freshMs=${FRESH_MS})`,
  );
}

function stopSessionWarmer() {
  if (morningJob) { morningJob.stop(); morningJob = null; }
  if (refreshJob) { refreshJob.stop(); refreshJob = null; }
}

module.exports = {
  startSessionWarmer,
  stopSessionWarmer,
  runWarming,
  // Exposed for unit tests
  _selectDriversToWarm: selectDriversToWarm,
  _hasScheduleForToday: hasScheduleForToday,
};
