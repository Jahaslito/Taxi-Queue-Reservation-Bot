/**
 * Backlog-aware onset cap + target-horizon guard + growth-scaled lead —
 * the 2026-07-19 overshoot package (five-morning forensics, 314 fires).
 *
 * What each block pins:
 *   1. onsetBacklogBoost — the cap deepens ONLY on proven backlog (display
 *      slope ≥ 2/s AND an in-flight fire invisible in V Holding beyond the
 *      render+poll baseline). Confirm-latency alone must NOT deepen it (the
 *      07-19 stream-back case: 12 s confirms, backlog ~14 — deepening there
 *      replays to −19…−26 undershoot).
 *   2. onsetCapNow — boost raises the base dynamic cap, ceilinged at
 *      ONSET_CAP_MAX; without boost the pre-07-19 formula is unchanged.
 *   3. Target-horizon guard — deep early fire is prior-safe only below the
 *      storm-death boundary (storms run to 200–232; every onset undershoot
 *      breach was a target ≥196): ≤SAFE_HORIZON full cap, ≤MID_HORIZON at
 *      most MID_CAP, above that no onset fire at all.
 *   4. Growth-scaled lead — calm mornings stop spending lead-10 on growth
 *      that never comes (the −11…−13 pre-storm class, 6 of 9 breaches).
 *   5. Under-rescue detector (shadow) — flags a below-band landing exactly
 *      once, only after the storm dies AND the tail re-reaches the band.
 *
 * Run: npx jest tests/services/backlogOnset.test.js
 */

process.env.MONITOR_ONSET_FIRE         = '1';
process.env.MONITOR_ONSET_ZONE_MIN     = '40';
process.env.MONITOR_ONSET_ZONE_MAX     = '90';
process.env.MONITOR_ONSET_RATE         = '1.2';
process.env.MONITOR_ONSET_STEP         = '5';
process.env.MONITOR_ONSET_CAP          = '25';
process.env.MONITOR_ONSET_CAP_MAX      = '45';
process.env.MONITOR_ONSET_SAFE_HORIZON = '170';
process.env.MONITOR_ONSET_MID_HORIZON  = '200';
process.env.MONITOR_ONSET_MID_CAP      = '15';
process.env.MONITOR_ONSET_VIS_BASELINE_MS = '3500';
process.env.MONITOR_GROWTH_LEAD        = '1';
process.env.MONITOR_UNDER_RESCUE       = 'shadow';

const monitor = require('../../src/services/monitorService');
const {
  _evaluatePositionScheduler,
  _onsetStep,
  _onsetCapNow,
  _onsetBacklogBoost,
  _maybeFlagUnderRescue,
} = monitor;

const T0 = 1_700_000_000_000;
const fresh = () => ({ active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 });

/** Storm-armed onset state with a controlled render-step history. */
function stormState(steps /* [{agoMs, step}] */, nowMs = T0) {
  return {
    active: true,
    prevQueue: 100,
    lastEvidenceMs: nowMs,
    recentSteps: steps.map(({ agoMs, step }) => ({ t: nowMs - agoMs, step })),
    stepSeen: steps.length ? steps[steps.length - 1].step : 0,
  };
}

const makeState = (target, over = {}) => ({
  driverId: 42,
  vehicleNumber: '4007',
  scheduledPosition: target,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

const ctx = (waitingCount, over = {}) => ({
  waitingCount,
  effectiveGrowthRate: 1.5,
  estimatedDrift: 5,
  biasCorrection: 0,
  horizonSeconds: 4,
  botExecMs: 4000,
  todayDayKey: null,
  botSamplesCount: 10,
  queueShrinkageDetected: false,
  ...over,
});

describe('onsetBacklogBoost — proven-backlog gate', () => {
  test('inactive storm → no boost regardless of inputs', () => {
    const st = { ...stormState([{ agoMs: 2000, step: 30 }]), active: false };
    expect(_onsetBacklogBoost(st, { nowMs: T0, unseenAgeMs: 20000 }).boost).toBe(0);
  });

  test('slow display (<2/s over 10 s) → no boost even with old unseen fires', () => {
    // 15 positions over the last 10 s = 1.5/s — the calm-flurry case.
    const st = stormState([{ agoMs: 8000, step: 15 }]);
    expect(_onsetBacklogBoost(st, { nowMs: T0, unseenAgeMs: 20000 }).boost).toBe(0);
  });

  test('no in-flight invisible fire → no boost (07-19 stream-back case)', () => {
    // Steep display but every fire became visible within the baseline: the
    // 12 s WAIT-screen confirms were lag, not backlog — cap must stay base.
    const st = stormState([{ agoMs: 8000, step: 31 }, { agoMs: 3000, step: 26 }]);
    const bb = _onsetBacklogBoost(st, { nowMs: T0, unseenAgeMs: 3000 }); // < 3500 baseline
    expect(bb.boost).toBe(0);
  });

  test('deep proven backlog → slope × adjusted age (07-18 04:15:31 shape)', () => {
    // Display 73→104 over the last 10 s (steps +31, +26 ≈ 5.7/s) and the
    // oldest unconfirmed fire has been invisible for 11 s.
    const st = stormState([{ agoMs: 8000, step: 31 }, { agoMs: 3000, step: 26 }]);
    const bb = _onsetBacklogBoost(st, { nowMs: T0, unseenAgeMs: 11000 });
    expect(bb.slope10).toBeCloseTo(5.7, 5);
    expect(bb.visAgeS).toBeCloseTo(7.5, 5);     // 11 − 3.5 baseline
    expect(bb.boost).toBeCloseTo(42.75, 5);      // deep — near the 45 ceiling
  });

  test('steps older than 10 s do not count toward the slope', () => {
    const st = stormState([{ agoMs: 12000, step: 40 }, { agoMs: 3000, step: 8 }]);
    const bb = _onsetBacklogBoost(st, { nowMs: T0, unseenAgeMs: 20000 });
    expect(bb.slope10).toBeCloseTo(0.8, 5);      // only the +8 counts → gated off
    expect(bb.boost).toBe(0);
  });
});

describe('onsetCapNow — boost integration', () => {
  test('without boost the pre-07-19 dynamic formula is unchanged', () => {
    let st = _onsetStep(fresh(), { queue: 41, rate: 0.3, nowMs: T0 });
    st = _onsetStep(st, { queue: 46, rate: 0.3, nowMs: T0 + 5000 });   // lone +5
    expect(_onsetCapNow(st)).toBe(10);
    st = _onsetStep(st, { queue: 66, rate: 4, nowMs: T0 + 10000 });    // +20 chunk
    expect(_onsetCapNow(st)).toBe(25);                                  // full base cap
  });

  test('boost deepens past the base cap but never past ONSET_CAP_MAX', () => {
    const st = stormState([{ agoMs: 3000, step: 30 }]);
    expect(_onsetCapNow(st, 38.7)).toBe(38);                            // floor(boost)
    expect(_onsetCapNow(st, 90)).toBe(45);                              // CAP_MAX ceiling
    expect(_onsetCapNow(st, 0)).toBe(25);                               // base unchanged
  });
});

describe('target-horizon guard — storm-death protection', () => {
  const onsetCtx = (waitingCount, onsetCap) =>
    ctx(waitingCount, { onsetActive: true, onsetCap, effectiveGrowthRate: 8 });

  test('target ≤ SAFE_HORIZON gets the full boosted cap (mid-ramp rescue)', () => {
    // 07-18 04:15:31 shape: eff 104, target 145 (gap 41) — flat cap 20/25
    // held this driver to fire born-over at +53; cap 45 fires it now.
    const d = _evaluatePositionScheduler(makeState(145), onsetCtx(104, 45));
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('onset_early_fire');
  });

  test('SAFE_HORIZON < target ≤ MID_HORIZON is capped at MID_CAP', () => {
    // target 190, gap 16 > MID_CAP 15 → held, even though cap 45 would allow.
    expect(_evaluatePositionScheduler(makeState(190), onsetCtx(174, 45)).action).toBe('wait');
    // gap 14 ≤ 15 → fires.
    const d = _evaluatePositionScheduler(makeState(190), onsetCtx(176, 45));
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('onset_early_fire');
  });

  test('target > MID_HORIZON never onset-fires (the −18/−19 class at 231)', () => {
    // 07-16 #0082 / 07-19 #0003: target 250/251, fired early-by 19-20 at the
    // dying storm's q231 → landed −18/−19. The guard holds them for the plain
    // rule, which the post-storm drain serves at −6…−9.
    const d = _evaluatePositionScheduler(makeState(250), onsetCtx(231, 45));
    expect(d.action).toBe('wait');
  });

  test('plain projection still fires past-horizon targets on proven queue', () => {
    // Queue caught up: eff + lead ≥ target — normal fire, not onset.
    const d = _evaluatePositionScheduler(
      makeState(250),
      ctx(245, { onsetActive: true, onsetCap: 45, effectiveGrowthRate: 3 }),
    );
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('projection_reached_target');
  });
});

describe('growth-scaled lead — calm mornings stop overspending undershoot', () => {
  test('calm (0.2/s): lead collapses to ~3 — no fire 10 early, fires at target−3', () => {
    // The #4016/#4349 class: drift floor 5 + bias 10 spent lead-10 at 4 AM
    // calm; queue never grew during the 1.5 s commit → landed −11…−13.
    const calm = { effectiveGrowthRate: 0.2, estimatedDrift: 5, biasCorrection: 10 };
    expect(_evaluatePositionScheduler(makeState(35), ctx(25, calm)).action).toBe('wait');
    const d = _evaluatePositionScheduler(makeState(35), ctx(32, calm));
    expect(d.action).toBe('fire'); // 32 + min(15, 10, 3) = 35 ≥ 35
  });

  test('burst (3/s): cap is ≥ 11 — lead 10 unchanged, fires exactly as before', () => {
    const burst = { effectiveGrowthRate: 3.0, estimatedDrift: 15, biasCorrection: 0 };
    const d = _evaluatePositionScheduler(makeState(80), ctx(70, burst));
    expect(d.action).toBe('fire'); // 70 + min(15, 10, 11) = 80 ≥ 80
  });
});

describe('under-rescue detector (shadow, log-only)', () => {
  const logSpy = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  test('flags once when the storm is dead and the tail re-reaches the band', () => {
    const spy = logSpy();
    const state = makeState(250, { landedPositionToday: 232, positionFiredToday: true });
    _maybeFlagUnderRescue(state, 250, 247, 0.4);     // calm + queue in band
    expect(state.underRescueFlagged).toBe(true);
    expect(spy.mock.calls.some(([l]) => l.includes('UNDER-RESCUE'))).toBe(true);
    spy.mockClear();
    _maybeFlagUnderRescue(state, 250, 249, 0.4);     // second tick — no re-log
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
  });

  test('never flags mid-storm or before the tail returns, or for in-band landings', () => {
    const spy = logSpy();
    const mk = (landed) => makeState(250, { landedPositionToday: landed, positionFiredToday: true });
    const storm = mk(232); _maybeFlagUnderRescue(storm, 250, 247, 5.0);   // storm running
    const early = mk(232); _maybeFlagUnderRescue(early, 250, 238, 0.4);   // tail not back
    const inBand = mk(243); _maybeFlagUnderRescue(inBand, 250, 247, 0.4); // −7: fine
    expect(storm.underRescueFlagged ?? false).toBe(false);
    expect(early.underRescueFlagged ?? false).toBe(false);
    expect(inBand.underRescueFlagged ?? false).toBe(false);
    expect(spy.mock.calls.some(([l]) => l.includes('UNDER-RESCUE'))).toBe(false);
    spy.mockRestore();
  });
});
