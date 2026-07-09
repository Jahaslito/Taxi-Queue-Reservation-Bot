/**
 * Storm-onset early fire (MONITOR_ONSET_FIRE) — the anti-batch-add lever.
 *
 * 2026-07-08: a competitor batch jumped the displayed queue 66→105 inside one
 * 5 s render tick; every target in the jumped gap (78–113) fired born-over and
 * landed +32…+50. Level-triggered firing cannot beat an intra-tick chunk, so
 * this rule fires corridor drivers the moment the onset SIGNATURE appears
 * (queue in the position-locked onset zone + rate/step), spending bounded
 * undershoot: fire only while target − effectiveQueue ≤ ONSET_CAP, where
 * effectiveQueue is a proven lower bound of the true tail — so the worst case
 * (storm dies on the click) lands at target − ONSET_CAP at the earliest.
 *
 * These tests pin:
 *   1. onsetStep — arms only inside the zone on the signature, survives the
 *      storm, disarms after the quiet-tick cooldown.
 *   2. Live mode: eligible corridor drivers fire early (reason onset_early_fire);
 *      drivers whose gap exceeds the cap are HELD; calm ticks are unchanged.
 *   3. Shadow mode: never fires — annotates the wait line for replay.
 *   4. 07-08 replay shape: at the pre-step tick (queue 66) targets 78/90 fire
 *      early, target 113 holds, then fires normally at the 105 step.
 *
 * Flags are read at module load; jest.isolateModules gives shadow its own copy.
 */

process.env.MONITOR_ONSET_FIRE       = '1';
process.env.MONITOR_ONSET_ZONE_MIN   = '55';
process.env.MONITOR_ONSET_ZONE_MAX   = '90';
process.env.MONITOR_ONSET_RATE       = '1.2';
process.env.MONITOR_ONSET_STEP       = '8';
process.env.MONITOR_ONSET_CAP        = '25';
process.env.MONITOR_ONSET_QUIET_TICKS = '3';

const monitor = require('../../src/services/monitorService');
const { _evaluatePositionScheduler, _onsetStep } = monitor;

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

const fresh = () => ({ active: false, quietTicks: 0, prevQueue: null, stepSeen: 0 });

describe('onsetStep — storm-onset tracker', () => {
  test('arms inside the zone on a step ≥ threshold', () => {
    let st = _onsetStep(fresh(), { queue: 57, rate: 0.5 });   // prime prevQueue
    st = _onsetStep(st, { queue: 66, rate: 0.9 });            // +9 step in zone
    expect(st.active).toBe(true);
  });

  test('arms inside the zone on sustained rate', () => {
    let st = _onsetStep(fresh(), { queue: 60, rate: 1.5 });
    expect(st.active).toBe(true);
  });

  test('does NOT arm outside the zone (calm early queue, deep storm alike)', () => {
    expect(_onsetStep(fresh(), { queue: 30, rate: 5 }).active).toBe(false);
    expect(_onsetStep(fresh(), { queue: 200, rate: 5 }).active).toBe(false);
  });

  test('stays armed through the storm, disarms after quiet ticks', () => {
    let st = _onsetStep(fresh(), { queue: 60, rate: 2.0 });
    st = _onsetStep(st, { queue: 105, rate: 8.0 });           // storm running, out of zone
    expect(st.active).toBe(true);
    st = _onsetStep(st, { queue: 105, rate: 0.1 });           // quiet 1
    st = _onsetStep(st, { queue: 105, rate: 0.1 });           // quiet 2
    expect(st.active).toBe(true);
    st = _onsetStep(st, { queue: 105, rate: 0.1 });           // quiet 3 → cooldown
    expect(st.active).toBe(false);
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

  test('no onset → identical to today (waits)', () => {
    const d = _evaluatePositionScheduler(makeState(90), ctx(66, { onsetActive: false }));
    expect(d.action).toBe('wait');
    expect(d.logLine).not.toMatch(/ONSET/);
  });

  test('07-08 replay shape: held driver fires normally once the step reveals it', () => {
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
