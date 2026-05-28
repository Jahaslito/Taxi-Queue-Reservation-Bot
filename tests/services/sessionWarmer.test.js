/**
 * Session warmer — selection predicate tests
 *
 * Covers the BUSINESS RULE the warmer was built for:
 *   Pre-warm SAN sessions only for drivers who actually need them today,
 *   so the morning warm budget scales with usage and never logs in inactive
 *   or locked-out drivers.
 *
 * Strategy
 * ────────
 * selectDriversToWarm() is pure with all dependencies injectable, so we test
 * it directly without touching the cron, botService, or DB. Each test covers
 * a single filter dimension — keeps regressions easy to bisect.
 *
 * Run: npx jest tests/services/sessionWarmer.test.js
 */

// botService is imported indirectly through sessionWarmerService; we don't
// touch warmSession() in these tests so no Playwright is launched.

const { _selectDriversToWarm, _hasScheduleForToday } = require('../../src/services/sessionWarmerService');

// ─── Test fixture: 7 drivers, each isolating one filter dimension ────────────
const drivers = [
  // 1 — active + always-on position schedule → ALWAYS selected
  { id: 1, is_active: true,  san_username: 'u1', san_password: 'p',
    scheduled_position: 100 },

  // 2 — inactive → NEVER selected
  { id: 2, is_active: false, san_username: 'u2', san_password: 'p',
    scheduled_position: 100 },

  // 3 — no schedule at all → NEVER selected
  { id: 3, is_active: true,  san_username: 'u3', san_password: 'p' },

  // 4 — time schedule active on Wednesday (key '3')
  { id: 4, is_active: true,  san_username: 'u4', san_password: 'p',
    scheduled_time: '05:00', scheduled_days: '1,2,3,4,5' },

  // 5 — time schedule NOT active on Wednesday
  { id: 5, is_active: true,  san_username: 'u5', san_password: 'p',
    scheduled_time: '05:00', scheduled_days: '0,6' },

  // 6 — per-day position schedule with a target ONLY on Wednesday
  { id: 6, is_active: true,  san_username: 'u6', san_password: 'p',
    day_positions: JSON.stringify({ '3': 80 }) },

  // 7 — per-day position schedule with NO target on Wednesday
  { id: 7, is_active: true,  san_username: 'u7', san_password: 'p',
    day_positions: JSON.stringify({ '1': 80, '5': 90 }) },
];

const noLockouts        = () => false;
const noCachedSessions  = () => null;

describe('hasScheduleForToday', () => {
  test.each([
    ['always-on position',     drivers[0], '3', true],
    ['no schedule',            drivers[2], '3', false],
    ['time on matching day',   drivers[3], '3', true],
    ['time on off day',        drivers[4], '3', false],
    ['day_positions match',    drivers[5], '3', true],
    ['day_positions no match', drivers[6], '3', false],
  ])('%s', (_label, driver, dayKey, expected) => {
    expect(_hasScheduleForToday(driver, dayKey)).toBe(expected);
  });

  test('day_positions wins over scheduled_position when both present', () => {
    const d = {
      scheduled_position: 100,            // would qualify alone
      day_positions: JSON.stringify({}),  // empty for today → no target
    };
    expect(_hasScheduleForToday(d, '3')).toBe(false);
  });

  // Matches the conservative behavior of monitorService/schedulerService — a
  // corrupted JSON field shouldn't be silently treated as "no override," because
  // then a position-schedule driver would unexpectedly fall back to a different
  // target on the day their day_positions field gets mangled.
  test('malformed day_positions JSON → no schedule today (no fallback)', () => {
    const d = { scheduled_position: 100, day_positions: '{not-json' };
    expect(_hasScheduleForToday(d, '3')).toBe(false);
  });
});

describe('selectDriversToWarm — morning mode (no freshness gate)', () => {
  const opts = {
    dayKey: '3',
    mode:   'morning',
    isLockedOut:        noLockouts,
    getSessionSavedAt:  noCachedSessions,
  };

  test('selects only active drivers with a schedule today', () => {
    const selected = _selectDriversToWarm(drivers, opts).map(d => d.id);
    expect(selected).toEqual([1, 4, 6]);
  });

  test('excludes locked-out drivers', () => {
    const selected = _selectDriversToWarm(drivers, {
      ...opts, isLockedOut: (id) => id === 1,
    }).map(d => d.id);
    expect(selected).toEqual([4, 6]);
  });

  test('warms even drivers with a fresh cached session', () => {
    const now = 1_000_000;
    const selected = _selectDriversToWarm(drivers, {
      ...opts, now,
      getSessionSavedAt: () => now - 60_000, // 1 min old — fresh
    }).map(d => d.id);
    // Morning mode ignores freshness — all eligible still warmed.
    expect(selected).toEqual([1, 4, 6]);
  });

  test('excludes drivers missing SAN credentials', () => {
    const incomplete = [...drivers, {
      id: 99, is_active: true, scheduled_position: 100, // no san_username
    }];
    const selected = _selectDriversToWarm(incomplete, opts).map(d => d.id);
    expect(selected).not.toContain(99);
  });
});

describe('selectDriversToWarm — refresh mode (skips fresh sessions)', () => {
  const now     = 10_000_000;
  const freshMs = 2 * 60 * 60 * 1000; // 2 h
  const baseOpts = {
    dayKey: '3',
    mode:   'refresh',
    now,
    freshMs,
    isLockedOut:       noLockouts,
    getSessionSavedAt: noCachedSessions,
  };

  test('warms drivers with no cached session', () => {
    const selected = _selectDriversToWarm(drivers, baseOpts).map(d => d.id);
    expect(selected).toEqual([1, 4, 6]);
  });

  test('skips drivers whose cached session is younger than freshMs', () => {
    const recent = now - (freshMs - 60_000); // just inside the window
    const selected = _selectDriversToWarm(drivers, {
      ...baseOpts,
      getSessionSavedAt: (username) => username === 'u1' ? recent : null,
    }).map(d => d.id);
    expect(selected).toEqual([4, 6]);
  });

  test('warms drivers whose cached session is older than freshMs', () => {
    const stale = now - (freshMs + 60_000); // just past the window
    const selected = _selectDriversToWarm(drivers, {
      ...baseOpts,
      getSessionSavedAt: (username) => username === 'u1' ? stale : null,
    }).map(d => d.id);
    expect(selected).toEqual([1, 4, 6]);
  });

  test('treats exactly freshMs-old as stale (boundary fires)', () => {
    const selected = _selectDriversToWarm(drivers, {
      ...baseOpts,
      getSessionSavedAt: (username) => username === 'u1' ? now - freshMs : null,
    }).map(d => d.id);
    expect(selected).toContain(1);
  });
});
