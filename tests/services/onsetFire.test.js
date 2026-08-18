/**
 * Storm-onset early fire (MONITOR_ONSET_FIRE) — the anti-batch-add lever.
 *
 * v2 (2026-07-11): detector is RENDER-aware and ramp-tuned, with a dynamic
 * calm-guard cap. Forensics behind the changes:
 *   • 07-10: the +10 trigger step happened at q54 — one position below the old
 *     ZONE_MIN=55 — onset armed 6 s late, at the 15/s peak.
 *   • 07-11: the ramp's first acceleration was +5 at q41, below both old
 *     thresholds (zone 55, step 8) — armed 11 s late at 12/s.
 *   • 07-09: quiet-TICK counting disarmed mid-storm (display renders every
 *     ~5 s; 4 of 5 polls look calm between renders) — quiet is now TIME-based.
 *   • Calm guard: allowance = min(CAP, max(POS_MAX_LEAD, 2 × biggest render
 *     step in the last 20 s)) — a lone +5 calm flurry unlocks only ~10 early
 *     (the normal lead: no extra undershoot), real chunks unlock the full cap.
 *
 * Flags are read at module load; jest.isolateModules gives shadow its own copy.
 */

process.env.MONITOR_ONSET_FIRE     = '1';
process.env.MONITOR_ONSET_ZONE_MIN = '40';
process.env.MONITOR_ONSET_ZONE_MAX = '90';
process.env.MONITOR_ONSET_RATE     = '1.2';
process.env.MONITOR_ONSET_STEP     = '5';
process.env.MONITOR_ONSET_CAP      = '25';
process.env.MONITOR_ONSET_QUIET_MS = '25000';

const monitor = require('../../src/services/monitorService');
const { _evaluatePositionScheduler, _onsetStep, _onsetCapNow } = monitor;

const makeState = (target, over = {}) => ({
  driverId: 42,
  vehicleNumber: '4007',
  scheduledPosition: target,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

// Calm-projection ctx: lead = min(drift 5, 10) = 5 → projection well below the
// targets under test, so any fire can only come from the onset rule.
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

const fresh = () => ({ active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 });
const T0 = 1_700_000_000_000;

describe('onsetStep — render-aware storm-onset tracker', () => {
  test('arms inside the zone on a render step ≥ threshold (07-11 ramp: +5 at q41)', () => {
    let st = _onsetStep(fresh(), { queue: 36, rate: 0.4, nowMs: T0 });     // prime prevQueue
    st = _onsetStep(st, { queue: 41, rate: 0.9, nowMs: T0 + 5000 });      // +5 render in zone
    expect(st.active).toBe(true);
  });

  test('arms inside the zone on sustained rate', () => {
    let st = _onsetStep(fresh(), { queue: 60, rate: 1.5, nowMs: T0 });
    expect(st.active).toBe(true);
  });

  test('does NOT arm outside the zone (calm early queue, deep storm alike)', () => {
    let low = _onsetStep(fresh(), { queue: 20, rate: 5, nowMs: T0 });
    low = _onsetStep(low, { queue: 30, rate: 5, nowMs: T0 + 5000 });      // +10 but q < 40
    expect(low.active).toBe(false);
    let deep = _onsetStep(fresh(), { queue: 150, rate: 5, nowMs: T0 });
    deep = _onsetStep(deep, { queue: 190, rate: 5, nowMs: T0 + 5000 });   // +40 but q > 90
    expect(deep.active).toBe(false);
  });

  test('unchanged display between renders is NOT calm evidence (no tick decay)', () => {
    let st = _onsetStep(fresh(), { queue: 41, rate: 0.5, nowMs: T0 });
    st = _onsetStep(st, { queue: 51, rate: 2.0, nowMs: T0 + 5000 });      // armed
    for (let i = 1; i <= 20; i++) {                                       // 20 s of flat 1 s polls
      st = _onsetStep(st, { queue: 51, rate: 0.1, nowMs: T0 + 5000 + i * 1000 });
    }
    expect(st.active).toBe(true);                                          // < QUIET_MS — still armed
  });

  test('stays armed while the storm runs OUT of the zone (07-09 mid-storm fix)', () => {
    let st = _onsetStep(fresh(), { queue: 41, rate: 0.5, nowMs: T0 });
    st = _onsetStep(st, { queue: 56, rate: 2, nowMs: T0 + 5000 });        // armed in zone
    st = _onsetStep(st, { queue: 149, rate: 8, nowMs: T0 + 15000 });      // +93 step, out of zone
    st = _onsetStep(st, { queue: 186, rate: 8, nowMs: T0 + 21000 });
    expect(st.active).toBe(true);
  });

  test('disarms after QUIET_MS without storm evidence', () => {
    let st = _onsetStep(fresh(), { queue: 41, rate: 0.5, nowMs: T0 });
    st = _onsetStep(st, { queue: 51, rate: 2.0, nowMs: T0 + 5000 });      // armed
    st = _onsetStep(st, { queue: 52, rate: 0.1, nowMs: T0 + 5000 + 26000 }); // +1 render, 26 s later
    expect(st.active).toBe(false);
  });
});

describe('dynamic calm-guard cap (onsetCapNow)', () => {
  test('a lone +5 calm flurry unlocks only the normal lead (10)', () => {
    let st = _onsetStep(fresh(), { queue: 41, rate: 0.3, nowMs: T0 });
    st = _onsetStep(st, { queue: 46, rate: 0.3, nowMs: T0 + 5000 });      // +5 → armed
    expect(st.active).toBe(true);
    expect(_onsetCapNow(st)).toBe(10);                                     // max(10, 2×5) = 10
  });

  test('a real chunk unlocks the full cap within one render', () => {
    let st = _onsetStep(fresh(), { queue: 43, rate: 0.5, nowMs: T0 });
    st = _onsetStep(st, { queue: 56, rate: 3, nowMs: T0 + 5000 });        // +13 → 2×13 = 26 → clamp 25
    expect(_onsetCapNow(st)).toBe(25);
  });

  test('a multi-render ramp of small steps unlocks the full cap (08-16 signature)', () => {
    // 08-16 live: the ramp arrived as +4,+6,+6 across ~12 s — no single step
    // ≥ 7, so the legacy 2×max guard held the cap at 12 and the +21 leap one
    // render later swallowed the whole shallow cohort (+26…+48). Cumulative
    // evidence (MONITOR_ONSET_CUM, default on) reads the same ramp as Σ16 →
    // 2×16 = 32 → full cap.
    let st = _onsetStep(fresh(), { queue: 29, rate: 0.4, nowMs: T0 });
    st = _onsetStep(st, { queue: 33, rate: 1.5, nowMs: T0 + 4000 });      // +4
    st = _onsetStep(st, { queue: 39, rate: 2.0, nowMs: T0 + 8000 });      // +6
    st = _onsetStep(st, { queue: 45, rate: 2.8, nowMs: T0 + 12000 });     // +6 → armed in zone
    expect(st.active).toBe(true);
    expect(_onsetCapNow(st)).toBe(25);                                     // Σ16 → 32 → clamped to CAP
  });

  test('stale violence ages out of the cap window', () => {
    let st = _onsetStep(fresh(), { queue: 43, rate: 0.5, nowMs: T0 });
    st = _onsetStep(st, { queue: 56, rate: 3, nowMs: T0 + 5000 });        // +13
    st = _onsetStep(st, { queue: 57, rate: 3, nowMs: T0 + 26000 });       // +1; the +13 is 21 s old
    expect(_onsetCapNow(st)).toBe(10);                                     // only max(10, 2×1)
  });
});

describe('onset early fire — live mode', () => {
  test('corridor driver (gap ≤ cap) fires early with onset_early_fire', () => {
    const d = _evaluatePositionScheduler(makeState(90), ctx(66, { onsetActive: true }));
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('onset_early_fire');
    expect(d.logLine).toMatch(/ONSET early fire/);
    expect(d.logLine).toMatch(/early by 24 ≤ cap 25/);
    expect(d.fireOpts.predictedLanding).toBe(67); // effectiveQueue + 1 (lower bound)
  });

  test('gap wider than the cap is HELD (undershoot bound enforced)', () => {
    const d = _evaluatePositionScheduler(makeState(113), ctx(66, { onsetActive: true }));
    expect(d.action).toBe('wait'); // 113 − 66 = 47 > 25 → hold
  });

  test('scheduler honours the DYNAMIC cap from ctx (calm-guard end to end)', () => {
    const held = _evaluatePositionScheduler(makeState(85), ctx(66, { onsetActive: true, onsetCap: 10 }));
    expect(held.action).toBe('wait');                       // gap 19 > calm cap 10
    const fired = _evaluatePositionScheduler(makeState(75), ctx(66, { onsetActive: true, onsetCap: 10 }));
    expect(fired.reason).toBe('onset_early_fire');          // gap 9 ≤ 10 ≈ normal lead
    expect(fired.logLine).toMatch(/early by 9 ≤ cap 10/);
  });

  test('no onset → identical to today (waits)', () => {
    const d = _evaluatePositionScheduler(makeState(90), ctx(66, { onsetActive: false }));
    expect(d.action).toBe('wait');
    expect(d.logLine).not.toMatch(/ONSET/);
  });

  test('07-08 replay shape: held driver fires the moment the step closes his gap', () => {
    // Pre-step tick (queue 66, onset active): 78 and 90 go early, 113 holds.
    expect(_evaluatePositionScheduler(makeState(78),  ctx(66, { onsetActive: true })).reason).toBe('onset_early_fire');
    expect(_evaluatePositionScheduler(makeState(90),  ctx(66, { onsetActive: true })).reason).toBe('onset_early_fire');
    expect(_evaluatePositionScheduler(makeState(113), ctx(66, { onsetActive: true })).action).toBe('wait');
    // The +39 step tick (queue 105): 113's gap is now 8 ≤ cap → onset fires him
    // immediately (projection 105+5=110 would have waited another tick).
    const after = _evaluatePositionScheduler(makeState(113), ctx(105, { onsetActive: true }));
    expect(after.action).toBe('fire');
    expect(after.reason).toBe('onset_early_fire');
    expect(after.logLine).toMatch(/early by 8 ≤ cap 25/);
    // Next step (queue 152): a target already far below is a plain projection fire.
    const late = _evaluatePositionScheduler(makeState(130), ctx(152, { onsetActive: true }));
    expect(late.action).toBe('fire');
    expect(late.reason).toBe('projection_reached_target');
  });

  test('projection rule unaffected when it already fires', () => {
    const d = _evaluatePositionScheduler(makeState(70), ctx(66, { onsetActive: true }));
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('projection_reached_target'); // 66 + 5 = 71 ≥ 70 on its own
  });
});

describe('onset early fire — shadow mode', () => {
  test('would-fire is logged, nothing fires', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_ONSET_FIRE = 'shadow';
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(90), ctx(66, { onsetActive: true }));
      expect(d.action).toBe('wait');
      expect(d.logLine).toMatch(/ONSET-SHADOW: would fire early by 24 ≤ cap 25/);
    });
    process.env.MONITOR_ONSET_FIRE = '1'; // restore for any later isolate
  });

  test('shadow annotates only eligible drivers', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_ONSET_FIRE = 'shadow';
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(113), ctx(66, { onsetActive: true }));
      expect(d.action).toBe('wait');
      expect(d.logLine).not.toMatch(/ONSET-SHADOW/); // gap 47 > cap — no claim
    });
    process.env.MONITOR_ONSET_FIRE = '1';
  });
});
