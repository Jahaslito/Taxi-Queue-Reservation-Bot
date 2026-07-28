/**
 * Storm-watch cadence, dynamic prearm, and morning-complete release — the
 * 2026-07-27 SAN-load-reduction package. These pin the pure decision helpers
 * extracted from monitorService.poll():
 *
 *   1. computeStormReadiness — fleet prearm signal (movement OR earliest-target
 *      20-min lead); silent through pre-storm calm and post-storm plateau.
 *   2. isQueueActive — the 1 s-hold signal (onset / growth / imminent fire);
 *      NOT triggered by a merely-high plateau queue.
 *   3. computePollDelayMs — the cadence tiers, incl. the master fail-safe and the
 *      "morning firing done → normal rate" release. Idle floor never exceeds the
 *      adaptive rate.
 *   4. resolveTargetPosition — day-specific / base / no-target / malformed.
 *   5. Full morning lifecycle + the SMART_CADENCE=off fail-safe.
 *
 * Thresholds are pinned via env before require so the module consts are known.
 *
 * Run: npx jest tests/services/stormWatchCadence.test.js
 */

process.env.MONITOR_MOVEMENT_RATE      = '0.3';
process.env.MONITOR_IMMINENT_FIRE_SECS = '45';
process.env.MONITOR_POLL_MS            = '30000'; // normal adaptive idle
process.env.MONITOR_POLL_NEAR_FIRE_MS  = '10000';
process.env.MONITOR_POLL_AT_FIRE_MS    = '5000';
process.env.MONITOR_SMART_CADENCE      = 'true';
process.env.BOT_SESSION_PERSIST_PATH   = '/tmp/storm-watch-test-sessions.json';

const {
  _computeStormReadiness: readiness,
  _computePrearmReady:    prearmReady,
  _parsePrearmClockPT:    parseClock,
  _isQueueActive:         active,
  _computePollDelayMs:    delay,
  _resolveTargetPosition: target,
  _expectedNextPollMs:    adaptive,
} = require('../../src/services/monitorService');

const LEAD = 1200;          // 20-min prearm lead
const BURST = 1000, IDLE = 5000, NORMAL = 30000;

// ── 0. wall-clock prearm floor (2026-07-28) ─────────────────────────────────
describe('parsePrearmClockPT — env parsing', () => {
  test('parses HH:MM to minutes since midnight PT', () => {
    expect(parseClock('03:30')).toBe(210);
    expect(parseClock('4:00')).toBe(240);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('23:59')).toBe(1439);
  });
  test('malformed values fall back to 03:30 (210) — floor can never be disabled', () => {
    for (const bad of ['', 'nope', '3:3', '25:00', '03:60', '3.5', undefined, null]) {
      expect(parseClock(bad)).toBe(210);
    }
  });
});

describe('computePrearmReady — dynamic signal OR the 03:30 clock floor', () => {
  const C = 210; // 03:30 PT
  test('clock floor arms the fleet inside the window even with zero storm signal', () => {
    expect(prearmReady({ smart: true, stormBuilding: false, inWatchWindow: true,
                         minutesPT: 210, clockMinutes: C })).toBe(true);   // 03:30 sharp
    expect(prearmReady({ smart: true, stormBuilding: false, inWatchWindow: true,
                         minutesPT: 300, clockMinutes: C })).toBe(true);   // 05:00
  });
  test('before the floor, only the dynamic signal arms (clock never delays it)', () => {
    expect(prearmReady({ smart: true, stormBuilding: false, inWatchWindow: true,
                         minutesPT: 209, clockMinutes: C })).toBe(false);  // 03:29 calm
    expect(prearmReady({ smart: true, stormBuilding: true,  inWatchWindow: true,
                         minutesPT: 190, clockMinutes: C })).toBe(true);   // 03:10 storm!
  });
  test('window-bounded: the clock alone never holds the fleet armed outside it', () => {
    expect(prearmReady({ smart: true, stormBuilding: false, inWatchWindow: false,
                         minutesPT: 600, clockMinutes: C })).toBe(false);  // 10:00, window shut
    // …but a genuine storm signal still arms regardless of the window
    expect(prearmReady({ smart: true, stormBuilding: true,  inWatchWindow: false,
                         minutesPT: 600, clockMinutes: C })).toBe(true);
  });
  test('FAIL-SAFE (smart off): whole-window arming, clock ignored', () => {
    expect(prearmReady({ smart: false, stormBuilding: false, inWatchWindow: true,
                         minutesPT: 0, clockMinutes: C })).toBe(true);
    expect(prearmReady({ smart: false, stormBuilding: true, inWatchWindow: false,
                         minutesPT: 300, clockMinutes: C })).toBe(false);
  });
});

// ── 1. computeStormReadiness ────────────────────────────────────────────────
describe('computeStormReadiness — dynamic fleet prearm signal', () => {
  const base = { onsetActive: false, growthRate: 0, earliestTarget: 55, waitingCount: 12, leadSecs: LEAD };

  test('dead calm (rate 0) → not building, projection ∞', () => {
    const r = readiness(base);
    expect(r.secsToEarliestTarget).toBe(Infinity);
    expect(r.stormBuilding).toBe(false);
  });

  test('onset armed → building regardless of rate', () => {
    expect(readiness({ ...base, onsetActive: true }).stormBuilding).toBe(true);
  });

  test('growth ≥ movement threshold → building (isolated: no target in lead range)', () => {
    // earliestTarget ∞ removes the lead trigger so only the rate threshold decides.
    const iso = { onsetActive: false, earliestTarget: Infinity, waitingCount: 12, leadSecs: LEAD };
    expect(readiness({ ...iso, growthRate: 0.3  }).stormBuilding).toBe(true);
    expect(readiness({ ...iso, growthRate: 0.29 }).stormBuilding).toBe(false); // just under
  });

  test('gradual creep BELOW movement threshold still arms via 20-min lead (07-26 04:47)', () => {
    // rate 0.15 < 0.3, queue 36, earliest 50 → (50-36)/0.15 = 93s ≤ 1200 → build
    const r = readiness({ onsetActive: false, growthRate: 0.15, earliestTarget: 50, waitingCount: 36, leadSecs: LEAD });
    expect(r.secsToEarliestTarget).toBeCloseTo(93.3, 1);
    expect(r.stormBuilding).toBe(true);
  });

  test('creep too far out (beyond the lead) → not yet building', () => {
    // rate 0.05, queue 20, earliest 120 → (100)/0.05 = 2000s > 1200 → wait
    const r = readiness({ onsetActive: false, growthRate: 0.05, earliestTarget: 120, waitingCount: 20, leadSecs: LEAD });
    expect(r.secsToEarliestTarget).toBe(2000);
    expect(r.stormBuilding).toBe(false);
  });

  test('queue already past the earliest target → building (negative projection)', () => {
    const r = readiness({ onsetActive: false, growthRate: 0.1, earliestTarget: 50, waitingCount: 60, leadSecs: LEAD });
    expect(r.secsToEarliestTarget).toBeLessThan(0);
    expect(r.stormBuilding).toBe(true);
  });

  test('post-storm plateau: all fired (earliestTarget ∞) → not building', () => {
    const r = readiness({ onsetActive: false, growthRate: 0.03, earliestTarget: Infinity, waitingCount: 270, leadSecs: LEAD });
    expect(r.secsToEarliestTarget).toBe(Infinity);
    expect(r.stormBuilding).toBe(false);
  });

  test('negative/zero rate never divides (guards against ∞/NaN)', () => {
    expect(readiness({ ...base, growthRate: 0 }).secsToEarliestTarget).toBe(Infinity);
    expect(readiness({ ...base, growthRate: -1 }).secsToEarliestTarget).toBe(Infinity);
  });
});

// ── 2. isQueueActive ────────────────────────────────────────────────────────
describe('isQueueActive — the 1 s-hold signal', () => {
  test('onset armed → active', () => {
    expect(active({ onsetActive: true, growthRate: 0, minSecondsUntilFire: Infinity })).toBe(true);
  });
  test('growth ≥ threshold → active; below → not', () => {
    expect(active({ onsetActive: false, growthRate: 0.3, minSecondsUntilFire: Infinity })).toBe(true);
    expect(active({ onsetActive: false, growthRate: 0.1, minSecondsUntilFire: Infinity })).toBe(false);
  });
  test('imminent fire (≤45s) → active even with no growth', () => {
    expect(active({ onsetActive: false, growthRate: 0, minSecondsUntilFire: 45 })).toBe(true);
    expect(active({ onsetActive: false, growthRate: 0, minSecondsUntilFire: 46 })).toBe(false);
  });
  test('plateau: high queue but calm + no pending fire → NOT active', () => {
    // The bug the level-test would cause: a parked queue of 270 must read calm.
    expect(active({ onsetActive: false, growthRate: 0.03, minSecondsUntilFire: Infinity })).toBe(false);
  });
});

// ── 3. computePollDelayMs ───────────────────────────────────────────────────
describe('computePollDelayMs — cadence tiers', () => {
  const call = (o) => delay({ smart: true, burstMs: BURST, idleMs: IDLE, adaptiveMs: NORMAL, ...o });

  test('outside window → adaptive, regardless of activity', () => {
    expect(call({ inWatchWindow: false, firePending: true, queueActive: true })).toBe(NORMAL);
  });
  test('in window, fire pending, queue active → burst 1 s', () => {
    expect(call({ inWatchWindow: true, firePending: true, queueActive: true })).toBe(BURST);
  });
  test('in window, fire pending, queue idle → idle floor', () => {
    expect(call({ inWatchWindow: true, firePending: true, queueActive: false })).toBe(IDLE);
  });
  test('in window, NO fire pending (morning done) → adaptive, NOT idle floor', () => {
    expect(call({ inWatchWindow: true, firePending: false, queueActive: false })).toBe(NORMAL);
    // even if the queue looks active, nothing pending means nothing to catch:
    expect(call({ inWatchWindow: true, firePending: false, queueActive: true })).toBe(NORMAL);
  });
  test('idle floor never exceeds the adaptive rate (a nearer fire pulls it faster)', () => {
    // adaptive says 5 s (near fire) — idle floor min(5000, 5000) = 5 s
    expect(delay({ smart: true, inWatchWindow: true, firePending: true, queueActive: false,
      burstMs: BURST, idleMs: IDLE, adaptiveMs: 5000 })).toBe(5000);
    // adaptive says 5 s but idle floor is 5 s too → 5 s; if adaptive were faster it would win
    expect(delay({ smart: true, inWatchWindow: true, firePending: true, queueActive: false,
      burstMs: BURST, idleMs: IDLE, adaptiveMs: 3000 })).toBe(3000);
  });

  describe('FAIL-SAFE: smart cadence OFF reverts to always-burst-in-window', () => {
    const legacy = (o) => delay({ smart: false, burstMs: BURST, idleMs: IDLE, adaptiveMs: NORMAL, ...o });
    test('in window → burst 1 s regardless of pending/active (guaranteed readiness)', () => {
      expect(legacy({ inWatchWindow: true, firePending: false, queueActive: false })).toBe(BURST);
      expect(legacy({ inWatchWindow: true, firePending: true,  queueActive: true  })).toBe(BURST);
    });
    test('outside window → adaptive', () => {
      expect(legacy({ inWatchWindow: false, firePending: true, queueActive: true })).toBe(NORMAL);
    });
  });
});

// ── 4. resolveTargetPosition ────────────────────────────────────────────────
describe('resolveTargetPosition', () => {
  const KEY = 'mon';
  test('base scheduledPosition when no day map', () => {
    expect(target({ scheduledPosition: 100 }, KEY)).toBe(100);
  });
  test('day-specific override wins', () => {
    expect(target({ scheduledPosition: 100, dayPositions: JSON.stringify({ mon: 145, tue: 90 }) }, KEY)).toBe(145);
  });
  test('day map present but no entry for today → null (skip_no_target)', () => {
    expect(target({ scheduledPosition: 100, dayPositions: JSON.stringify({ tue: 90 }) }, KEY)).toBeNull();
  });
  test('malformed JSON → null, never throws', () => {
    expect(target({ scheduledPosition: 100, dayPositions: '{bad json' }, KEY)).toBeNull();
  });
  test('no target at all → null', () => {
    expect(target({ scheduledPosition: null }, KEY)).toBeNull();
    expect(target({ scheduledPosition: 0 }, KEY)).toBeNull(); // 0 is not a valid position
  });
});

// ── 5. Full morning lifecycle (composition) ─────────────────────────────────
describe('full morning cadence lifecycle', () => {
  // Reproduces poll()'s composition: earliestTarget → readiness → active → delay.
  const tick = ({ inWindow, onset, rate, minSecs, earliest, waiting, firePending, smart = true }) => {
    const q = active({ onsetActive: onset, growthRate: rate, minSecondsUntilFire: minSecs });
    return delay({ smart, inWatchWindow: inWindow, firePending, queueActive: q,
      burstMs: BURST, idleMs: IDLE, adaptiveMs: adaptive(minSecs) });
  };

  test('SMART: calm→creep→storm→done→requeue→plateau', () => {
    expect(tick({ inWindow: false, onset: false, rate: 0,    minSecs: Infinity, firePending: true  })).toBe(NORMAL); // 02:30 pre-window
    expect(tick({ inWindow: true,  onset: false, rate: 0.1,  minSecs: Infinity, firePending: true  })).toBe(IDLE);   // 03:30 calm, pending
    expect(tick({ inWindow: true,  onset: true,  rate: 6.7,  minSecs: 3,        firePending: true  })).toBe(BURST);  // 04:48 storm
    expect(tick({ inWindow: true,  onset: false, rate: 0.1,  minSecs: Infinity, firePending: false })).toBe(NORMAL); // 05:50 highest fired → DONE
    expect(tick({ inWindow: true,  onset: false, rate: 0.03, minSecs: Infinity, firePending: false })).toBe(NORMAL); // 06:30 plateau
    expect(tick({ inWindow: true,  onset: false, rate: 0.1,  minSecs: Infinity, firePending: true  })).toBe(IDLE);   // 07:15 requeue → re-tighten
    expect(tick({ inWindow: false, onset: false, rate: 0,    minSecs: Infinity, firePending: false })).toBe(NORMAL); // 08:30 after window
  });

  test('FAIL-SAFE morning: 1 s across the whole window, done or not', () => {
    expect(tick({ smart: false, inWindow: true,  onset: false, rate: 0,   minSecs: Infinity, firePending: false })).toBe(BURST);
    expect(tick({ smart: false, inWindow: true,  onset: false, rate: 6.7, minSecs: 3,        firePending: true  })).toBe(BURST);
    expect(tick({ smart: false, inWindow: false, onset: false, rate: 0,   minSecs: Infinity, firePending: false })).toBe(NORMAL);
  });
});
