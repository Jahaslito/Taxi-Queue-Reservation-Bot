/**
 * Pre-onset ladder (MONITOR_LADDER) — see the LADDER constant block in
 * monitorService.
 *
 * The failure it closes (08-21/08-22 live, the two worst days recorded): the
 * storm window cannot absorb the roster — when the display leap arrives below
 * the shallowest target, no threshold has fired yet and the whole roster fires
 * into one tick (104 and 92 fires/1s, ±10 = 5% and 2%). The good mornings
 * (08-15, 74%) worked because the pre-dawn crawl walked the queue through the
 * targets one at a time — an emergent ladder where each of our own commits
 * unlocks the next target. This rule ignites that chain deliberately in the
 * calm window: fire any driver whose target is within LADDER_GAP (11) of the
 * effective queue, serialized LADDER_TICK_MAX per tick. Landing bound by
 * construction: ≥ queue + 1 ≥ target − 10 — in-band on the undershoot side.
 *
 * Flags are read at module load; jest.isolateModules gives the kill-switch and
 * shadow tests their own copy.
 */

process.env.MONITOR_LADDER               = '1';
process.env.MONITOR_LADDER_GAP           = '11';
process.env.MONITOR_LADDER_TICK_MAX      = '2';
process.env.MONITOR_LADDER_MAX_VEL       = '0.5';
process.env.MONITOR_TICK_PIPE_LEAD       = '0';
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
const { _evaluatePositionScheduler, _setLadderLastFireMs } = monitor;

const makeState = (target, over = {}) => ({
  driverId: 7,
  vehicleNumber: '0675',
  scheduledPosition: target,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

// Calm pre-onset ctx: the 08-21/22 pre-storm shape — queue crawled to 29,
// first target 40, no onset evidence, velocity ~0.
const calmCtx = (over = {}) => ({
  waitingCount: 29,
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
  observedVelocity: 0.01,
  currentInflight: 0,
  ladderWindowOpen: true,
  ...over,
});

beforeEach(() => _setLadderLastFireMs(0));

describe('ladder eligibility — calm pre-onset window', () => {
  test('fires a driver whose target is within the gap (the 08-21 first rung)', () => {
    // Target 40, queue 29: gap 11 ≤ 11 → fire. This exact driver waited
    // through both catastrophes and got massacred in the wall.
    const d = _evaluatePositionScheduler(makeState(40), calmCtx());
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('ladder_fire');
    // Worst-case landing = queue + 1 = 30 = target − 10 — in-band.
    expect(d.fireOpts.predictedLanding).toBe(30);
  });

  test('holds a driver whose gap exceeds LADDER_GAP', () => {
    const d = _evaluatePositionScheduler(makeState(41), calmCtx());
    expect(d.action).toBe('wait');
  });

  test('the chain unlocks the next rung as the queue rises on our own commits', () => {
    // Same target-41 driver, one committed add later (queue 30): gap 11 → fire.
    const d = _evaluatePositionScheduler(makeState(41), calmCtx({ waitingCount: 30 }));
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('ladder_fire');
  });

  test('does not fire outside the wall-clock window', () => {
    const d = _evaluatePositionScheduler(makeState(40), calmCtx({ ladderWindowOpen: false }));
    expect(d.action).toBe('wait');
  });

  test('yields to the storm machinery the moment onset arms', () => {
    const d = _evaluatePositionScheduler(makeState(40), calmCtx({ onsetActive: true, onsetCap: 10 }));
    // Onset active with gap 11 > cap 10 and projection short → wait, not ladder.
    expect(d.action).toBe('wait');
  });

  test('yields when the queue is genuinely moving (storm velocity)', () => {
    const d = _evaluatePositionScheduler(
      makeState(40),
      calmCtx({ observedVelocity: 0.6 }),
    );
    expect(d.reason).not.toBe('ladder_fire');
  });

  test('a driver already at/past target fires by projection, not the ladder', () => {
    const d = _evaluatePositionScheduler(makeState(29), calmCtx());
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('projection_reached_target');
  });
});

describe('pred-lead suppression while the chain is climbing', () => {
  test('band drivers do not pred-fire off chain motion', () => {
    _setLadderLastFireMs(Date.now());
    // Queue 55, target 70 (band). Chain motion grazes the 0.5/s move gate.
    // Without suppression: pred lead ≥ floor 20 → 55+20 ≥ 70 would FIRE at −14.
    const d = _evaluatePositionScheduler(
      makeState(70),
      calmCtx({ waitingCount: 55, observedVelocity: 0.55 }),
    );
    expect(d.action).toBe('wait');
  });

  test('a real storm (velocity ≥ 1.0/s) re-enables pred-lead despite recent chain fires', () => {
    _setLadderLastFireMs(Date.now());
    const d = _evaluatePositionScheduler(
      makeState(70),
      calmCtx({ waitingCount: 55, observedVelocity: 2.0, currentInflight: 26 }),
    );
    // pred lead = clamp(19+0.86×26)=41 → 55+41 ≥ 70 → fires on the storm path.
    expect(d.action).toBe('fire');
    expect(d.reason).toBe('projection_reached_target');
  });
});

describe('kill switch and shadow — MONITOR_LADDER', () => {
  test("'0' disables the ladder entirely", () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER = '0';
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(40), calmCtx());
      expect(d.action).toBe('wait');
      delete process.env.MONITOR_LADDER;
    });
  });

  test("'shadow' logs the would-fire but does not fire", () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER = 'shadow';
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(40), calmCtx());
      expect(d.action).toBe('wait');
      expect(d.logLine).toContain('LADDER-SHADOW');
      delete process.env.MONITOR_LADDER;
    });
  });
});
