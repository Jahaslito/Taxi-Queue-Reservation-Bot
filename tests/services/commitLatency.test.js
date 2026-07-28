/**
 * SAN commit-latency instrumentation — the 2026-07-28 storm-overshoot package.
 *
 * The scheduler's drift horizon measures the BOT's run time (decision → click)
 * but was blind to SAN's own commit latency (click → slot stamped). On the
 * 2026-07-27 storm that gap stalled to 22–42 s while the queue climbed, so every
 * pending fire landed 150+ past target. These pin the rolling-median estimator
 * that now measures it:
 *
 *   1. recordCommitLatency / commitLatencyEstimateMs — median over fresh samples.
 *   2. Cold start & MIN_SAMPLES gate → 0 (a no-op horizon contribution).
 *   3. Freshness window discards stale samples (12 h default).
 *   4. Garbage guard: non-finite, ≤0, and absurd (>10 min) samples rejected.
 *
 * Run: npx jest tests/services/commitLatency.test.js
 */

process.env.BOT_SESSION_PERSIST_PATH = '/tmp/commit-latency-test-sessions.json';

const {
  _recordCommitLatency:       record,
  _commitLatencyEstimateMs:   estimate,
  _resetCommitLatencySamples: reset,
} = require('../../src/services/monitorService');

const FRESHNESS_MS = 12 * 60 * 60 * 1000; // matches LATENCY_FRESHNESS_MS default

beforeEach(() => reset());

// ── 1. Median over fresh samples ────────────────────────────────────────────
test('returns the median once enough fresh samples exist', () => {
  const now = 1_000_000;
  [1000, 3000, 2000, 5000, 4000].forEach((ms) => record(ms, { now }));
  // median of [1000,2000,3000,4000,5000] = 3000
  expect(estimate({ now })).toBe(3000);
});

test('even sample count averages the two middle values', () => {
  const now = 1_000_000;
  [1000, 2000, 3000, 4000, 5000, 6000].forEach((ms) => record(ms, { now }));
  // median of six = (3000 + 4000) / 2
  expect(estimate({ now })).toBe(3500);
});

// ── 2. Cold-start / MIN_SAMPLES gate → 0 (no-op) ────────────────────────────
test('returns 0 with no samples (cold start = current behaviour)', () => {
  expect(estimate()).toBe(0);
});

test('returns 0 below the minimum sample threshold', () => {
  const now = 1_000_000;
  [22000, 30000, 42000].forEach((ms) => record(ms, { now })); // only 3 (< MIN 5)
  expect(estimate({ now })).toBe(0);
});

// ── 3. Freshness window ─────────────────────────────────────────────────────
test('discards samples older than the freshness window', () => {
  const t0 = 1_000_000;
  // 5 old samples, then move well past the freshness window
  [22000, 24000, 26000, 28000, 30000].forEach((ms) => record(ms, { now: t0 }));
  const later = t0 + FRESHNESS_MS + 1;
  expect(estimate({ now: later })).toBe(0); // all aged out → cold-start 0
});

test('keeps fresh samples and drops only the stale ones', () => {
  const t0 = 1_000_000;
  [90000, 90000].forEach((ms) => record(ms, { now: t0 })); // stale outliers
  const t1 = t0 + FRESHNESS_MS + 1;
  [1000, 2000, 3000, 4000, 5000].forEach((ms) => record(ms, { now: t1 }));
  expect(estimate({ now: t1 })).toBe(3000); // stale 90 s pair excluded
});

// ── 4. Garbage guard ────────────────────────────────────────────────────────
test('rejects non-positive, non-finite, and absurdly large samples', () => {
  const now = 1_000_000;
  record(-500, { now });                 // clock skew
  record(0, { now });                    // zero
  record(NaN, { now });                  // non-finite
  record(Infinity, { now });             // non-finite
  record(11 * 60 * 1000, { now });       // >10 min — an unrelated later landing
  expect(estimate({ now })).toBe(0);     // nothing recorded

  // valid ones still land
  [1000, 2000, 3000, 4000, 5000].forEach((ms) => record(ms, { now }));
  expect(estimate({ now })).toBe(3000);
});
