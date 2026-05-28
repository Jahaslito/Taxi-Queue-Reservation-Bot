'use strict';

// ─── Proxy health / circuit breaker ──────────────────────────────────────────
//
// Single source of truth for "should we route this call through the upstream
// proxy?". Three reasons we'd say NO:
//
//   1. PROXY_ENABLED=false           — operator kill switch (observation mode)
//   2. PROXY_SERVER not set          — proxy isn't configured at all
//   3. circuit breaker is OPEN       — N consecutive failures observed recently
//
// Everything that wants to know — the bot's getProxyConfig, the monitor's
// poll dispatcher, the warmer — calls shouldUseProxy() and acts on the answer.
// Failures get reported back via reportFailure(); successes via reportSuccess().
//
// Why a circuit breaker rather than per-call try/fallback:
//   • Per-call fallback pays a ~10-15 s TCP/CONNECT timeout BEFORE falling back,
//     on EVERY failed call. With our poll cadence + retry pattern that turns
//     a dead proxy into a sustained 80 % wall-clock loss.
//   • A breaker pays that cost ONCE (during the failures that trip it), then
//     every subsequent call is fast-path direct until the cooldown ends.
//   • Probe-on-cooldown-end means we self-recover the moment the proxy comes
//     back, no human intervention needed.
//
// State machine:
//
//   HEALTHY ──(consecutiveFails ≥ FAIL_THRESHOLD)──► OPEN (cooldown active)
//      ▲                                                 │
//      │                                                 │ (cooldown elapsed)
//      │                                                 ▼
//      │                                              HALF_OPEN
//      │              ┌────(reportSuccess)─────────────┘    │
//      │              │                                     │ (reportFailure)
//      └──────────────┘                                     ▼
//                                                      OPEN (new cooldown)
//
// HALF_OPEN is implicit — once cooldown elapses, shouldUseProxy() returns true
// again, and the very next reportFailure trips the breaker anew.

const FAIL_THRESHOLD = parseInt(process.env.PROXY_FAIL_THRESHOLD ?? '3', 10);
const COOLDOWN_MS    = parseInt(process.env.PROXY_COOLDOWN_MS    ?? '300000', 10); // 5 min
const ENABLED        = process.env.PROXY_ENABLED !== 'false';

// Mutable state — kept at module scope for the same reason JobQueue is:
// every caller in the process needs to see the same view.
let consecutiveFails = 0;
let cooldownUntil    = 0;
let lastTripReason   = null;
let lastTripAt       = null;
let totalTrips       = 0;

/**
 * Returns true if the next call should try the proxy.
 * Returns false if the operator disabled it, it isn't configured, or the
 * breaker is currently open.
 *
 * `now` is injectable so tests can advance time without faking the clock.
 */
function shouldUseProxy({ now = Date.now() } = {}) {
  if (!ENABLED) return false;
  if (!process.env.PROXY_SERVER) return false;
  if (now < cooldownUntil) return false;
  return true;
}

/**
 * Report a connection-level failure that's plausibly the proxy's fault.
 * Connection-level: fetch failed / ECONNREFUSED / ETIMEDOUT / proxy 407.
 * NOT for SAN-side errors (HTTP 5xx, "Add To Queue button not found", etc.)
 * — those don't say anything about proxy health.
 *
 * Trips the breaker if it pushes us past FAIL_THRESHOLD.
 */
function reportFailure(reason = 'unknown', { now = Date.now() } = {}) {
  // If we're already in cooldown, no need to do anything — extra failures
  // during the down window don't extend it.
  if (now < cooldownUntil) return;

  consecutiveFails++;
  if (consecutiveFails >= FAIL_THRESHOLD) {
    cooldownUntil  = now + COOLDOWN_MS;
    lastTripReason = reason;
    lastTripAt     = new Date(now);
    totalTrips++;
    console.error(
      `[Proxy] ⛔ Circuit OPEN after ${consecutiveFails} consecutive failures (last: ${reason}) — ` +
      `falling back to direct for ${(COOLDOWN_MS / 1000).toFixed(0)}s`,
    );
  }
}

/**
 * Report a successful call. Clears the failure counter and — if we were in
 * cooldown — closes the breaker so the next call goes back through the proxy.
 *
 * (In practice this only fires post-cooldown because shouldUseProxy() blocks
 * proxy use during cooldown, so no call could have succeeded via proxy then.
 * But we handle "manual probe" use cases too.)
 */
function reportSuccess({ now = Date.now() } = {}) {
  if (cooldownUntil > 0 && now >= cooldownUntil) {
    console.log('[Proxy] ✓ Recovered — circuit CLOSED');
  }
  consecutiveFails = 0;
  cooldownUntil    = 0;
}

/** Current breaker view — exposed for the admin health endpoint. */
function getState({ now = Date.now() } = {}) {
  const isCooldown = now < cooldownUntil;
  return {
    enabled:              ENABLED,
    proxyConfigured:      !!process.env.PROXY_SERVER,
    healthy:              shouldUseProxy({ now }),
    state:                isCooldown ? 'OPEN' : (consecutiveFails > 0 ? 'DEGRADED' : 'HEALTHY'),
    consecutiveFails,
    cooldownRemainingMs:  isCooldown ? cooldownUntil - now : 0,
    failThreshold:        FAIL_THRESHOLD,
    cooldownMs:           COOLDOWN_MS,
    lastTripReason,
    lastTripAt,
    totalTrips,
  };
}

/** Test helper: clear all state so suites don't bleed into each other. */
function _reset() {
  consecutiveFails = 0;
  cooldownUntil    = 0;
  lastTripReason   = null;
  lastTripAt       = null;
  totalTrips       = 0;
}

module.exports = {
  shouldUseProxy,
  reportFailure,
  reportSuccess,
  getState,
  _reset,
  // Exposed so callers can name the breaker-trip reason consistently.
  FAIL_THRESHOLD,
  COOLDOWN_MS,
  ENABLED,
};
