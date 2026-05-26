'use strict';

// ─── Credential lockout (in-memory, PT day-scoped) ────────────────────────────
//
// When the bot confirms a driver's SAN credentials are wrong, parking the
// driver until end-of-PT-day prevents 30+ "took too long" retries throughout
// the day. The lockout self-clears at midnight PT — drivers who update their
// password earlier should still trigger a clear via clearLockout().
//
// Why in-memory and not a DB column:
//   • Lockouts are inherently transient (≤ 24h) and trivial to re-establish
//     on restart — the next bot run after restart re-detects the same error
//     and re-arms the breaker.
//   • Zero migration cost.
//   • One Map lookup per fire decision; O(1).
//
// If we ever need persistence (e.g. surfacing "credentials invalid" in the
// admin UI across restarts) the right move is a column on `drivers` — but
// that's a bigger change than this fix calls for.

/** @type {Map<number, { reason: string, at: Date, dayKey: string }>} */
const lockouts = new Map();

function todayKeyPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Lock a driver out of further bot runs for the rest of today (PT).
 * Safe to call multiple times — subsequent calls refresh the reason/timestamp
 * but keep the dayKey, so the breaker still self-clears at midnight PT.
 */
function lockOut(driverId, reason) {
  if (!Number.isInteger(driverId)) return;
  lockouts.set(driverId, {
    reason: reason || 'unknown',
    at:     new Date(),
    dayKey: todayKeyPT(),
  });
  console.log(`[CredentialLockout] ⛔ driver ${driverId} locked out for today — ${reason}`);
}

/**
 * Returns the lockout entry if the driver is currently locked out, or null.
 * Auto-expires entries from previous PT days (lazy cleanup — cheaper than a
 * scheduled job for a Map this small).
 */
function getLockout(driverId) {
  const entry = lockouts.get(driverId);
  if (!entry) return null;
  if (entry.dayKey !== todayKeyPT()) {
    lockouts.delete(driverId);
    return null;
  }
  return entry;
}

function isLockedOut(driverId) {
  return getLockout(driverId) !== null;
}

/**
 * Clear the lockout for a driver — call after they update their SAN password
 * (so the next scheduled run actually fires) or on a successful bot run.
 */
function clearLockout(driverId) {
  if (lockouts.delete(driverId)) {
    console.log(`[CredentialLockout] ✓ driver ${driverId} lockout cleared`);
  }
}

/**
 * Returns the message bytes a credentials error sets — useful so the same
 * detection logic lives in one place (botService raises the error with this
 * substring, sanitizeError + isTransientError + this module all key off it).
 */
function isCredentialError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return m.includes('invalid san') || m.includes('check your credentials')
      || m.includes('check credentials') || m.includes('login failed');
}

/**
 * Test-only: wipe the entire lockout map. Used by tests' afterEach to prevent
 * state leakage between cases (DB truncation can reuse driver ids, so a
 * lockout armed in one test could silently apply in the next).
 */
function _reset() { lockouts.clear(); }

module.exports = { lockOut, getLockout, isLockedOut, clearLockout, isCredentialError, _reset };
