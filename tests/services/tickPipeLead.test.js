/**
 * Tick-pipe lead pass (MONITOR_TICK_PIPE_LEAD) — see runTickPipePass and the
 * TICK_PIPE_LEAD constant block in monitorService.
 *
 * The failure it closes (08-16 live): every decision in a poll tick reads ONE
 * currentInflight snapshot taken before any of that tick's own fires clicked,
 * so all 42 fires of the onset-leap batch read inflight 26, got the same ~41
 * lead, and landed a uniform +26…+48 (median +35). SAN appends in click-arrival
 * order, so a fire standing behind k of our own uncommitted adds lands ≥ k past
 * its click queue BY CONSTRUCTION — the same-tick batch is guaranteed drift.
 * The pass re-evaluates the tick's still-waiting drivers with the live batch
 * size folded into inflight, lowest target first, growing the count as fires
 * are added.
 *
 * Flags are read at module load; jest.isolateModules gives the kill-switch
 * test its own copy.
 */

process.env.MONITOR_TICK_PIPE_LEAD       = '1'; // default is OFF since 08-22 — these tests exercise the mechanism
process.env.MONITOR_PREDICTIVE_LEAD      = '1';
process.env.MONITOR_PRED_DRIFT_INTERCEPT = '19';
process.env.MONITOR_PRED_DRIFT_SLOPE     = '0.86';
process.env.MONITOR_PRED_LEAD_FLOOR      = '20';
process.env.MONITOR_PRED_LEAD_CAP        = '65';
process.env.MONITOR_PRED_LEAD_HARD_FLOOR = '65';
process.env.MONITOR_PRED_LEAD_MIN_TARGET = '70';
process.env.MONITOR_PRED_LEAD_MAX_TARGET = '199';
process.env.MONITOR_PRED_LEAD_MOVE_RATE  = '0.5';

const monitor = require('../../src/services/monitorService');
const { _runTickPipePass, _evaluatePositionScheduler } = monitor;

const makeState = (target, over = {}) => ({
  driverId: 7,
  vehicleNumber: '0675',
  scheduledPosition: target,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

// Mid-storm ctx: queue 66, burst window, queue genuinely moving, inflight 26 —
// the 08-16 leap tick. Base pred lead = min(65, 19 + 0.86×26) ≈ 41, so targets
// above 66+41=107 waited in pass 1 by construction.
const stormCtx = (over = {}) => ({
  waitingCount: 66,
  effectiveGrowthRate: 5,
  estimatedDrift: 30,
  biasCorrection: 0,
  horizonSeconds: 4,
  botExecMs: 4000,
  todayDayKey: null,
  botSamplesCount: 10,
  queueShrinkageDetected: false,
  inBurstWindow: true,
  onsetActive: false,
  observedVelocity: 5,
  currentInflight: 26,
  ...over,
});

const fakeBatch = (n) =>
  Array.from({ length: n }, (_, i) => ({ driverId: 1000 + i, state: {}, decision: {} }));

describe('runTickPipePass — same-tick batch counted into the lead', () => {
  test('a waiter the stale snapshot left behind fires once the batch is counted', () => {
    // Pass 1 verdict at inflight 26: lead 41 → projection 107 < 120 → wait.
    const state = makeState(120);
    expect(_evaluatePositionScheduler(state, stormCtx()).action).toBe('wait');

    // Same tick, 42 fires already collected: inflight 26+42=68 → lead capped
    // at 65 → projection 131 ≥ 120 → the pass promotes the waiter.
    const fireBatch = fakeBatch(42);
    const added = _runTickPipePass(
      fireBatch,
      [{ driverId: 7, state, target: 120 }],
      stormCtx(),
    );
    expect(added).toBe(1);
    expect(state.positionFiredToday).toBe(true);
    expect(fireBatch).toHaveLength(43);
    expect(fireBatch[42].decision.action).toBe('fire');
  });

  test('count grows as fires are added — lowest target first', () => {
    const s120 = makeState(120);
    const s131 = makeState(131, { vehicleNumber: '0387' });
    const fireBatch = fakeBatch(42);
    // Deliberately passed high-target-first: the pass must sort ascending so
    // the k-th added fire sees exactly the k−1 ahead of it.
    const added = _runTickPipePass(
      fireBatch,
      [
        { driverId: 8, state: s131, target: 131 },
        { driverId: 7, state: s120, target: 120 },
      ],
      stormCtx(),
    );
    // 120 fires at batch 42 (projection 131 ≥ 120); 131 then fires at batch 43.
    expect(added).toBe(2);
    expect(s120.positionFiredToday).toBe(true);
    expect(s131.positionFiredToday).toBe(true);
    expect(fireBatch[42].state).toBe(s120);
    expect(fireBatch[43].state).toBe(s131);
  });

  test('a waiter still out of reach stays waiting — no forced fire', () => {
    // Target 200 is beyond even the capped lead (66+65=131 < 200) and beyond
    // the hard floor (display 66 < 200−65=135) — the pass must leave it alone.
    const state = makeState(199);
    const added = _runTickPipePass(
      fakeBatch(42),
      [{ driverId: 9, state, target: 199 }],
      stormCtx(),
    );
    expect(added).toBe(0);
    expect(state.positionFiredToday).toBe(false);
  });

  test('no-ops when the tick fired nothing (calm tick)', () => {
    const state = makeState(120);
    const added = _runTickPipePass([], [{ driverId: 7, state, target: 120 }], stormCtx());
    expect(added).toBe(0);
    expect(state.positionFiredToday).toBe(false);
  });

  test('skips drivers already fired by an earlier sub-pass', () => {
    const state = makeState(120, { positionFiredToday: true });
    const fireBatch = fakeBatch(42);
    const added = _runTickPipePass(fireBatch, [{ driverId: 7, state, target: 120 }], stormCtx());
    expect(added).toBe(0);
    expect(fireBatch).toHaveLength(42);
  });

  test('one throwing evaluation never blocks the rest of the pass', () => {
    const good = makeState(120);
    const bad  = makeState(110, { vehicleNumber: '9999' });
    const boom = (state, ctx) => {
      if (state === bad) throw new Error('boom');
      return _evaluatePositionScheduler(state, ctx);
    };
    const fireBatch = fakeBatch(42);
    const added = _runTickPipePass(
      fireBatch,
      [
        { driverId: 11, state: bad, target: 110 },
        { driverId: 7, state: good, target: 120 },
      ],
      stormCtx(),
      boom,
    );
    expect(added).toBe(1);
    expect(good.positionFiredToday).toBe(true);
    expect(bad.positionFiredToday).toBe(false);
  });
});

describe('kill switch — MONITOR_TICK_PIPE_LEAD=0', () => {
  test('the pass is inert even with an eligible waiter and a big batch', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_TICK_PIPE_LEAD = '0';
      const off = require('../../src/services/monitorService');
      const state = makeState(120);
      const added = off._runTickPipePass(
        fakeBatch(42),
        [{ driverId: 7, state, target: 120 }],
        stormCtx(),
      );
      expect(added).toBe(0);
      expect(state.positionFiredToday).toBe(false);
      delete process.env.MONITOR_TICK_PIPE_LEAD;
    });
  });
});
