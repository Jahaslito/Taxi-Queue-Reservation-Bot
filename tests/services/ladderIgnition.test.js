/**
 * Chain IGNITION from an empty queue (2026-09-03) — see the LADDER_SEED_DEEP
 * block and the docker-compose "BE THE ONSET FOR REAL" note.
 *
 * What 09-03 proved: with SEED_GAP 35 / SHALLOW 29 a seed could only fire once
 * the queue was within 35 of a target, so the pre-storm chain never ignited
 * from an empty queue — it waited for the competitor's own warm-up (queue
 * ~15-20), 30-60 s before the flood, on all 8 of the last 8 mornings. The
 * whole roster then met the flood reactively (56 fires in one tick at q43,
 * ±10 4%, 14 drivers with no position, worst +171).
 *
 * The production shape under test: uniform cap SHALLOW = GAP = 70 (ignition
 * from queue 0 + strict lowest-target-first order), DEEP 29 for ≥200 targets,
 * PROACTIVE live + FULL, and our own adds removed from the velocity and onset
 * signals so the chain cannot trip the storm machinery on itself.
 */

process.env.MONITOR_LADDER                 = '1';
process.env.MONITOR_LADDER_GAP             = '11';
process.env.MONITOR_LADDER_TICK_MAX        = '2';
process.env.MONITOR_LADDER_MAX_VEL         = '0.5';
process.env.MONITOR_LADDER_SEED_GAP        = '70';
process.env.MONITOR_LADDER_SEED_SHALLOW    = '70';
process.env.MONITOR_LADDER_SEED_DEEP       = '29';
process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT = '4';
process.env.MONITOR_LADDER_PROACTIVE       = '1';
process.env.MONITOR_LADDER_PROACTIVE_FULL  = '1';
process.env.MONITOR_TICK_PIPE_LEAD         = '0';
process.env.MONITOR_PREDICTIVE_LEAD        = '1';
process.env.MONITOR_PRED_DRIFT_INTERCEPT   = '19';
process.env.MONITOR_PRED_DRIFT_SLOPE       = '0.86';
process.env.MONITOR_PRED_LEAD_FLOOR        = '20';
process.env.MONITOR_PRED_LEAD_CAP          = '65';
process.env.MONITOR_PRED_LEAD_HARD_FLOOR   = '65';
process.env.MONITOR_PRED_LEAD_OUTER_FLOOR  = '30';
process.env.MONITOR_PRED_LEAD_MIN_TARGET   = '70';
process.env.MONITOR_PRED_LEAD_MAX_TARGET   = '199';
process.env.MONITOR_PRED_LEAD_MOVE_RATE    = '0.5';
process.env.MONITOR_PRED_VEL_WINDOW        = '8';
process.env.MONITOR_ONSET_FIRE             = '1';
process.env.MONITOR_ONSET_ZONE_MIN         = '20';
process.env.MONITOR_ONSET_ZONE_MAX         = '90';
process.env.MONITOR_ONSET_RATE             = '1.2';
process.env.MONITOR_ONSET_STEP             = '5';
process.env.MONITOR_LADDER_SEED_MIN_QUEUE  = '20';

const m = require('../../src/services/monitorService');
const {
  _evaluatePositionScheduler,
  _runLadderSeedPass,
  _setLadderLastFireMs,
  _bumpLadderAdds,
  _recordVelocityObservation,
  _observedVelocity,
  _ownAddRate,
  _onsetStep,
} = m;

let nextId = 100;
const makeState = (target, over = {}) => ({
  driverId: nextId++,
  vehicleNumber: String(target).padStart(4, '0'),
  scheduledPosition: target,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

// 03:40 PT on a storm morning: queue EMPTY, dead calm, no growth signal, the
// proactive window open at full depth.
const emptyCtx = (over = {}) => ({
  waitingCount: 0,
  effectiveGrowthRate: 0.01,
  estimatedDrift: 0,
  biasCorrection: 0,
  horizonSeconds: 4,
  botExecMs: 4000,
  todayDayKey: null,
  botSamplesCount: 10,
  queueShrinkageDetected: false,
  inBurstWindow: true,
  onsetActive: false,
  observedVelocity: 0,
  currentInflight: 0,
  ladderWindowOpen: true,
  seedWindowOpen: true,
  seedRise: 0,
  proactiveOpen: true,
  proactiveFrac: 1,
  ...over,
});

const waiter = (target, effQ) => {
  const state = makeState(target);
  return { driverId: state.driverId, state, target, effQ };
};

beforeEach(() => _setLadderLastFireMs(0));

describe('ignition — the first rung is reachable from an EMPTY queue', () => {
  test('a target-46 driver (the 09-03 lowest target) is a seed candidate once the queue reaches the floor (20)', () => {
    const d = _evaluatePositionScheduler(makeState(46), emptyCtx({ waitingCount: 20 }));
    expect(d.action).toBe('wait');           // the seed PASS promotes it, not the loop
    expect(d.seedCandidate).toBe(true);
    expect(d.seedCanFire).toBe(true);
  });

  test('the seed pass fires it at the floor — the chain ignites by the clock, not on the competitor', () => {
    const batch = [];
    const w = waiter(46, 20);
    const added = _runLadderSeedPass(batch, [w], emptyCtx({ waitingCount: 20 }), 0);
    expect(added).toBe(1);
    expect(batch[0].decision.action).toBe('fire');
    expect(batch[0].decision.reason).toBe('ladder_fire');
    expect(w.state.positionFiredToday).toBe(true);
    // Worst-case landing = queue + 1 = 21 — the floor lifts it off position 1.
    expect(batch[0].decision.fireOpts.predictedLanding).toBe(21);
  });

  test('every shallow target (<70) is reachable at the floor — the uniform cap covers the whole cohort', () => {
    const d = _evaluatePositionScheduler(makeState(69), emptyCtx({ waitingCount: 20 }));
    expect(d.seedCanFire).toBe(true);        // gap 49 ≤ 70
  });
});

describe('strict target order — no band driver jumps a shallower target', () => {
  test('the seed pass promotes the LOWEST target first when both are eligible', () => {
    const batch = [];
    const band = waiter(70, 5);     // 08-27 cliff: target 70 used to fire at queue 5 ahead of 40-69
    const shallow = waiter(52, 5);
    const ctx = emptyCtx({ waitingCount: 5 });
    // budget 1 this tick: MAX_INFLIGHT 4 − inflight 3
    const added = _runLadderSeedPass(batch, [band, shallow], { ...ctx, currentInflight: 3 }, 0);
    expect(added).toBe(1);
    expect(batch[0].state.scheduledPosition).toBe(52);
    expect(band.state.positionFiredToday).toBe(false);
  });

  test('the band hard floor (−65) still holds target 70 until the chain lifts the queue to 5', () => {
    // The floor is applied at fire time, so the seed PASS (not the candidate
    // flag) is what must decline — and it consumes no budget doing so.
    const heldBatch = [];
    expect(_runLadderSeedPass(heldBatch, [waiter(70, 4)], emptyCtx({ waitingCount: 4 }), 0)).toBe(0);
    expect(heldBatch).toHaveLength(0);
    const okBatch = [];
    expect(_runLadderSeedPass(okBatch, [waiter(70, 5)], emptyCtx({ waitingCount: 5 }), 0)).toBe(1);
    expect(okBatch[0].decision.fireOpts.predictedLanding).toBe(6);
  });

  test('inflight budget: at most SEED_MAX_INFLIGHT (4) of our seeds in flight', () => {
    const batch = [];
    const ws = [46, 48, 51, 53, 55, 55].map((t) => waiter(t, 0));
    const added = _runLadderSeedPass(batch, ws, emptyCtx(), 0);
    expect(added).toBe(4);
    expect(batch.map((b) => b.state.scheduledPosition)).toEqual([46, 48, 51, 53]);
  });
});

describe('DEEP cap — ≥200 targets are never chained deep', () => {
  test('target 200 at queue 130 (gap 70) is NOT a seed candidate (DEEP cap 29)', () => {
    const d = _evaluatePositionScheduler(makeState(200), emptyCtx({ waitingCount: 130 }));
    expect(d.seedCanFire ?? false).toBe(false);
  });

  test('target 200 at queue 172 (gap 28 ≤ 29) is a seed candidate', () => {
    const d = _evaluatePositionScheduler(makeState(200), emptyCtx({ waitingCount: 172 }));
    expect(d.seedCanFire).toBe(true);
  });

  test('a band target (199) at gap 65 is still chained (band budget, hard floor −65)', () => {
    const d = _evaluatePositionScheduler(makeState(199), emptyCtx({ waitingCount: 134 }));
    expect(d.seedCanFire).toBe(true);
  });
});

describe('our own adds are invisible to the storm detectors', () => {
  test('observedVelocity subtracts our own chain adds (chain at 0.5-1/s reads ~0)', () => {
    const T0 = 1_700_000_000_000;
    _recordVelocityObservation(10, T0);
    _bumpLadderAdds(6);                       // six of our seeds fired in the window
    _recordVelocityObservation(16, T0 + 8000); // display +6 over 8 s = 0.75/s raw
    expect(_observedVelocity(T0 + 8000)).toBe(0);
    expect(_ownAddRate(T0 + 8000)).toBeCloseTo(0.75, 2);
  });

  test('a real flood still shows through the correction', () => {
    const T0 = 1_700_000_100_000;
    _recordVelocityObservation(20, T0);
    _bumpLadderAdds(4);
    _recordVelocityObservation(80, T0 + 8000); // +60 in 8 s, 4 of them ours → 7/s external (capped at PRED_VEL_CAP)
    expect(_observedVelocity(T0 + 8000)).toBeGreaterThan(1.0);
  });

  test('onsetStep: a +4 render made of OUR adds is not onset evidence', () => {
    const T0 = 1_700_000_200_000;
    const fresh = { active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 };
    let st = _onsetStep(fresh, { queue: 30, rate: 0.3, nowMs: T0, ours: 10 });
    // Next poll: display +5 inside the zone, but 4 of those 5 are our own seeds.
    st = _onsetStep(st, { queue: 35, rate: 0.8, nowMs: T0 + 5000, ours: 14 });
    expect(st.stepSeen).toBe(1);
    expect(st.active).toBe(false);
  });

  test('onsetStep: the same +5 render with NO adds of ours IS onset evidence (unchanged)', () => {
    const T0 = 1_700_000_300_000;
    const fresh = { active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 };
    let st = _onsetStep(fresh, { queue: 30, rate: 0.3, nowMs: T0, ours: 14 });
    st = _onsetStep(st, { queue: 35, rate: 0.8, nowMs: T0 + 5000, ours: 14 });
    expect(st.stepSeen).toBe(5);
    expect(st.active).toBe(true);
  });

  test('onsetStep without `ours` behaves exactly as before (legacy callers)', () => {
    const T0 = 1_700_000_400_000;
    const fresh = { active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 };
    let st = _onsetStep(fresh, { queue: 30, rate: 0.3, nowMs: T0 });
    st = _onsetStep(st, { queue: 35, rate: 0.8, nowMs: T0 + 5000 });
    expect(st.stepSeen).toBe(5);
    expect(st.active).toBe(true);
  });
});

describe('SEED_MIN_QUEUE — the deep seed holds until the queue reaches the floor', () => {
  test('at queue 0 the lowest target is NOT yet a seed candidate (floor 20)', () => {
    const d = _evaluatePositionScheduler(makeState(46), emptyCtx({ waitingCount: 0 }));
    expect(d.seedCanFire ?? false).toBe(false);
  });
  test('at queue 19 it still holds', () => {
    const d = _evaluatePositionScheduler(makeState(46), emptyCtx({ waitingCount: 19 }));
    expect(d.seedCanFire ?? false).toBe(false);
  });
  test('at queue 20 the seed releases — and lands no lower than ~21', () => {
    const d = _evaluatePositionScheduler(makeState(46), emptyCtx({ waitingCount: 20 }));
    expect(d.seedCanFire).toBe(true);
    const batch = [];
    _runLadderSeedPass(batch, [waiter(46, 20)], emptyCtx({ waitingCount: 20 }), 0);
    expect(batch[0].decision.fireOpts.predictedLanding).toBe(21);
  });
  test('still ascending by target once released (lowest target first)', () => {
    const batch = [];
    _runLadderSeedPass(batch, [waiter(70, 20), waiter(52, 20)],
      emptyCtx({ waitingCount: 20, currentInflight: 3 }), 0);
    expect(batch[0].state.scheduledPosition).toBe(52);
  });
});
