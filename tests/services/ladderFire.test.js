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
process.env.MONITOR_LADDER_SEED_GAP      = '65';
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
const {
  _evaluatePositionScheduler,
  _setLadderLastFireMs,
  _runLadderSeedPass,
  _sustainedRise,
  _recordSeedQueueObservation,
  _bumpLadderAdds,
} = monitor;

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
  seedWindowOpen: true,
  seedRise: 30, // "the list is building" — enough to unlock the full seed budget
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

describe('seed tier — MONITOR_LADDER_SEED_GAP (the 08-23 empty-queue shape)', () => {
  // 08-23 live: queue sat at 0-9 until 05:15, first target ~50 — the gap-11
  // chain had nothing to ignite from and the whole roster hit the wall (+45 p50).
  const emptyCtx = (over = {}) => calmCtx({ waitingCount: 5, ...over });

  test('SHALLOW SCOPING: a target-50 driver at queue 5 is NEVER seeded (would land ~6)', () => {
    // The operator contract: the full −65 budget is band-only (70-199).
    // Shallow targets cap at SEED_SHALLOW (29) — target 50 needs queue ≥ 21.
    const d = _evaluatePositionScheduler(makeState(50), emptyCtx());
    expect(d.action).toBe('wait');
    expect(d.seedCandidate).toBeFalsy();
  });

  test('a shallow driver seeds only inside the −30-contract cap (target 50 at queue 25 → lands ≥26)', () => {
    const d = _evaluatePositionScheduler(makeState(50), calmCtx({ waitingCount: 25 }));
    expect(d.action).toBe('wait');
    expect(d.seedCandidate).toBe(true);
  });

  test('a BAND driver gets the full budget (target 100 at queue 40, gap 60 ≤ 65)', () => {
    const d = _evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40 }));
    expect(d.action).toBe('wait');
    expect(d.seedCandidate).toBe(true);
  });

  test('a band driver beyond the budget is not a candidate (gap 70 > 65)', () => {
    const d = _evaluatePositionScheduler(makeState(110), calmCtx({ waitingCount: 40 }));
    expect(d.seedCandidate).toBeFalsy();
  });

  test('a deep driver (≥200) is capped at the shallow gap, not the band budget', () => {
    // Target 210 at queue 160: gap 50 ≤ 65 but ≥200 caps at 29 → not a candidate.
    const d = _evaluatePositionScheduler(makeState(210), calmCtx({ waitingCount: 160 }));
    expect(d.seedCandidate).toBeFalsy();
  });

  test('the pass promotes exactly ONE candidate, lowest target first', () => {
    const s50 = makeState(50);
    const s55 = makeState(55, { vehicleNumber: '0388' });
    const fireBatch = [];
    const added = _runLadderSeedPass(
      fireBatch,
      [
        { driverId: 8, state: s55, target: 55 },
        { driverId: 7, state: s50, target: 50 },
      ],
      calmCtx({ waitingCount: 25 }),
      0,
    );
    expect(added).toBe(1);
    expect(s50.positionFiredToday).toBe(true);
    expect(s55.positionFiredToday).toBe(false);
    expect(fireBatch).toHaveLength(1);
    expect(fireBatch[0].decision.reason).toBe('ladder_fire');
    // Landing bound: queue + 1 = 26 → err −24, inside the −30 contract, zero overshoot.
    expect(fireBatch[0].decision.fireOpts.predictedLanding).toBe(26);
    expect(fireBatch[0].decision.logLine).toContain('seed');
  });

  test('the pass holds while our own commits are in flight', () => {
    const s100 = makeState(100);
    const added = _runLadderSeedPass(
      [], [{ driverId: 7, state: s100, target: 100 }],
      calmCtx({ waitingCount: 40, currentInflight: 2 }), 0,
    );
    expect(added).toBe(0);
    expect(s100.positionFiredToday).toBe(false);
  });

  test('the pass holds when the gap-11 chain already progressed this tick', () => {
    const s100 = makeState(100);
    const added = _runLadderSeedPass(
      [], [{ driverId: 7, state: s100, target: 100 }],
      calmCtx({ waitingCount: 40 }), 2,
    );
    expect(added).toBe(0);
  });

  test('seed gap 0 disables the tier', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_GAP = '0';
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40 }));
      expect(d.seedCandidate).toBeFalsy();
      const added = m._runLadderSeedPass(
        [], [{ driverId: 7, state: makeState(100), target: 100 }],
        calmCtx({ waitingCount: 40 }), 0,
      );
      expect(added).toBe(0);
      process.env.MONITOR_LADDER_SEED_GAP = '65';
    });
  });

  test('empty env string inherits the hard floor instead of NaN-disabling the tier', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_GAP = ''; // compose passes '' when unset
      const m = require('../../src/services/monitorService');
      const d = m._evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40 }));
      expect(d.seedCandidate).toBe(true); // budget = HARD_FLOOR (65) → gap 60 eligible
      process.env.MONITOR_LADDER_SEED_GAP = '65';
    });
  });
});

describe('seed GROWTH gate — undershoot must be informed by how the list is growing', () => {
  test('DEAD CALM (no growth) never seeds, even with a band target in budget range', () => {
    // The 08-23 dead-calm shape: queue 40 flat for 15 min, storm not forming.
    // A gap-60 band target would seed under the old proximity rule; the growth
    // gate holds it — the driver waits and lands accurate.
    const d = _evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40, seedRise: 0 }));
    expect(d.action).toBe('wait');
    expect(d.seedCandidate).toBeFalsy();
  });

  test('a jitter-level rise below MIN_RISE does not open the gate', () => {
    const d = _evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40, seedRise: 5 }));
    expect(d.seedCandidate).toBeFalsy();
  });

  test('WEAK growth unlocks only shallow depth (rise 8 → ~24 positions)', () => {
    // rise 8 → allow = min(budget, 8×3=24). A gap-20 target seeds; gap-40 doesn't.
    const near = _evaluatePositionScheduler(makeState(75), calmCtx({ waitingCount: 55, seedRise: 8 }));
    expect(near.seedCandidate).toBe(true);          // gap 20 ≤ 24
    const far = _evaluatePositionScheduler(makeState(95), calmCtx({ waitingCount: 55, seedRise: 8 }));
    expect(far.seedCandidate).toBeFalsy();           // gap 40 > 24 — too deep for weak growth
  });

  test('STRONG growth unlocks the full band budget (rise 22 → 65)', () => {
    const d = _evaluatePositionScheduler(makeState(130), calmCtx({ waitingCount: 70, seedRise: 22 }));
    expect(d.seedCandidate).toBe(true);              // gap 60 ≤ 65
  });

  test('the promoted seed depth scales with growth — a deep band target waits until the ramp is strong', () => {
    const s = makeState(130); // gap 60 at queue 70
    const weak = _runLadderSeedPass(
      [], [{ driverId: 7, state: s, target: 130 }],
      calmCtx({ waitingCount: 70, seedRise: 8 }), 0,
    );
    expect(weak).toBe(0);                            // 8×3=24 < 60 — not yet
    const strong = _runLadderSeedPass(
      [], [{ driverId: 7, state: s, target: 130 }],
      calmCtx({ waitingCount: 70, seedRise: 22 }), 0,
    );
    expect(strong).toBe(1);                          // 22×3=66 ≥ 60 — now
  });
});

describe('sustainedRise — the growth signal', () => {
  test('a flat/jittering queue nets ~0; a real ramp nets clearly positive', () => {
    jest.isolateModules(() => {
      const m = require('../../src/services/monitorService');
      const t0 = 1_000_000;
      // Dead calm: bounce 3..8 across 160s.
      [[0,5],[20,3],[40,7],[60,4],[80,8],[100,5],[120,6],[140,4],[160,5]]
        .forEach(([dt, q]) => m._recordSeedQueueObservation(q, t0 + dt * 1000));
      expect(Math.abs(m._sustainedRise(t0 + 160_000))).toBeLessThan(8);
    });
    jest.isolateModules(() => {
      const m = require('../../src/services/monitorService');
      const t0 = 2_000_000;
      // A sustained climb 5 → 29 over 150s.
      [[0,5],[30,9],[60,14],[90,20],[120,25],[150,29]]
        .forEach(([dt, q]) => m._recordSeedQueueObservation(q, t0 + dt * 1000));
      expect(m._sustainedRise(t0 + 150_000)).toBeGreaterThanOrEqual(20);
    });
  });

  test('a climb driven by OUR OWN seeds does NOT open the gate (no feedback loop)', () => {
    jest.isolateModules(() => {
      const m = require('../../src/services/monitorService');
      const t0 = 3_000_000;
      // Queue climbs 5 → 25 but EVERY added position is one of our own seeds.
      const steps = [[0,5],[30,9],[60,13],[90,17],[120,21],[150,25]];
      steps.forEach(([dt, q], i) => {
        m._bumpLadderAdds(i === 0 ? 0 : 4); // +4 of our adds per 30s step = the whole climb
        m._recordSeedQueueObservation(q, t0 + dt * 1000);
      });
      // Raw rise is +20, but all of it is ours ⇒ external rise ≈ 0 ⇒ gate shut.
      expect(m._sustainedRise(t0 + 150_000)).toBeLessThan(8);
    });
  });
});

describe('PROACTIVE seed — be the onset during the daily storm window', () => {
  // Proactive is read at module load; give it its own isolated copy so the
  // default-off suite above is unaffected.
  const withProactive = (mode, fn) => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_PROACTIVE       = mode;
      process.env.MONITOR_LADDER_PROACTIVE_AFTER = '04:00';
      process.env.MONITOR_LADDER_PROACTIVE_PEAK  = '05:10';
      const m = require('../../src/services/monitorService');
      fn(m);
      delete process.env.MONITOR_LADDER_PROACTIVE;
    });
  };
  // Dead-calm ctx (no growth) but inside the proactive window at a given frac.
  const proCtx = (over = {}) => calmCtx({ seedRise: 0, proactiveOpen: true, proactiveFrac: 1, ...over });

  test('LIVE: fires a band driver on the clock prior even with ZERO growth', () => {
    withProactive('1', (m) => {
      // frac 1 (at/after peak) → full band budget 65. target 100, queue 40, gap 60.
      const d = m._evaluatePositionScheduler(makeState(100), proCtx({ waitingCount: 40 }));
      expect(d.action).toBe('wait');
      expect(d.seedCandidate).toBe(true);
      expect(d.seedCanFire).toBe(true);     // proactive-live can fire it
    });
  });

  test('LIVE: depth ramps with the clock — early window only unlocks shallow depth', () => {
    withProactive('1', (m) => {
      // frac 0.1 → allow ≈ 11 + (65-11)*0.1 ≈ 16. gap 60 too deep; gap 15 ok.
      const deep = m._evaluatePositionScheduler(makeState(100), proCtx({ waitingCount: 40, proactiveFrac: 0.1 }));
      expect(deep.seedCanFire).toBeFalsy();
      const near = m._evaluatePositionScheduler(makeState(90), proCtx({ waitingCount: 75, proactiveFrac: 0.1 }));
      expect(near.seedCanFire).toBe(true);   // gap 15 ≤ ~16
    });
  });

  test('LIVE: shallow/deep scoping still holds — target 50 never seeded to ~2', () => {
    withProactive('1', (m) => {
      const d = m._evaluatePositionScheduler(makeState(50), proCtx({ waitingCount: 5 }));
      expect(d.seedCandidate).toBeFalsy();   // shallow cap 29 → needs queue ≥ 21
    });
  });

  test('LIVE: yields the instant onset arms', () => {
    withProactive('1', (m) => {
      const d = m._evaluatePositionScheduler(makeState(100), proCtx({ waitingCount: 40, onsetActive: true, onsetCap: 10 }));
      expect(d.seedCandidate).toBeFalsy();
    });
  });

  test('LIVE: yields once the queue is genuinely leaping (velocity ≥ MAX_VEL)', () => {
    withProactive('1', (m) => {
      const d = m._evaluatePositionScheduler(makeState(100), proCtx({ waitingCount: 40, observedVelocity: 0.6 }));
      expect(d.seedCandidate).toBeFalsy();
    });
  });

  test('SHADOW: marks a would-seed candidate (funnel) but never fire-allowed', () => {
    withProactive('shadow', (m) => {
      const d = m._evaluatePositionScheduler(makeState(100), proCtx({ waitingCount: 40 }));
      expect(d.action).toBe('wait');
      expect(d.seedCandidate).toBe(true);        // in the funnel
      expect(d.seedCanFire).toBe(false);         // shadow can never fire
      expect(d.seedProactiveOnly).toBe(true);
    });
  });

  test('SHADOW pass logs one candidate per day and advances, without firing', () => {
    withProactive('shadow', (m) => {
      const logs = [];
      const spy = jest.spyOn(console, 'log').mockImplementation((s) => logs.push(s));
      const w = (veh, tgt) => ({ driverId: veh, state: { vehicleNumber: veh }, target: tgt, effQ: 40 });
      const first  = m._runLadderSeedShadowPass([w('A', 100), w('B', 90)], Date.UTC(2026,7,24,12));
      const second = m._runLadderSeedShadowPass([w('A', 100), w('B', 90)], Date.UTC(2026,7,24,12));
      spy.mockRestore();
      expect(first).toBe(1);
      expect(second).toBe(1);
      // lowest target first (B=90 then A=100), each once
      expect(logs[0]).toContain('#B');
      expect(logs[0]).toContain('PROACTIVE-SHADOW');
      expect(logs[1]).toContain('#A');
    });
  });

  test('OFF (default): proactive contributes nothing, growth gate still governs', () => {
    // Uses the top-of-file module (proactive unset ⇒ off). Dead calm + window
    // flags present but proactive OFF ⇒ no seed.
    const d = _evaluatePositionScheduler(makeState(100), calmCtx({ waitingCount: 40, seedRise: 0, proactiveOpen: true, proactiveFrac: 1 }));
    expect(d.seedCandidate).toBeFalsy();
  });
});

describe('front-loaded chain — MONITOR_LADDER_SEED_MAX_INFLIGHT + _FULL (08-24, "cannot afford a miss")', () => {
  // Three band candidates that all clear the seed budget at queue 70
  // (gaps 20/25/30 ≤ 65) — the calm pre-onset rungs the chain seats ascending.
  const bandWaiters = () => [
    { driverId: 23, state: makeState(100, { vehicleNumber: '0023' }), target: 100 },
    { driverId: 21, state: makeState(90,  { vehicleNumber: '0021' }), target: 90  },
    { driverId: 22, state: makeState(95,  { vehicleNumber: '0022' }), target: 95  },
  ];
  const seedCtx = (over = {}) => calmCtx({ waitingCount: 70, seedRise: 30, ...over });

  test('DEFAULT (unset ⇒ 1): still promotes exactly ONE per tick — backward compatible', () => {
    // Top-of-file module: MAX_INFLIGHT unset ⇒ 1 ⇒ budget 1 ⇒ one seed, as before.
    const added = _runLadderSeedPass([], bandWaiters(), seedCtx(), 0);
    expect(added).toBe(1);
  });

  test('N=3 front-loads up to three seeds in one tick, lowest target first', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT = '3';
      const m = require('../../src/services/monitorService');
      const fireBatch = [];
      const added = m._runLadderSeedPass(fireBatch, bandWaiters(), seedCtx(), 0);
      expect(added).toBe(3);
      // ascending target order — the chain lands 90 → 95 → 100
      expect(fireBatch.map((f) => f.state.vehicleNumber)).toEqual(['0021', '0022', '0023']);
      delete process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT;
    });
  });

  test('N caps concurrency: N=2 promotes only two of three eligible', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT = '2';
      const m = require('../../src/services/monitorService');
      const added = m._runLadderSeedPass([], bandWaiters(), seedCtx(), 0);
      expect(added).toBe(2);
      delete process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT;
    });
  });

  test('in-flight commits count against the budget (N=5, 3 in flight ⇒ 2 more)', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT = '5';
      const m = require('../../src/services/monitorService');
      const added = m._runLadderSeedPass([], bandWaiters(), seedCtx({ currentInflight: 3 }), 0);
      expect(added).toBe(2);
      delete process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT;
    });
  });

  test("this tick's gap-chain fires also count (N=3, 2 ladder fires ⇒ 1 seed)", () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT = '3';
      const m = require('../../src/services/monitorService');
      const added = m._runLadderSeedPass([], bandWaiters(), seedCtx(), 2);
      expect(added).toBe(1);
      delete process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT;
    });
  });

  test('_FULL=1 opens full band depth on the prior (loads + fires a deep band driver)', () => {
    jest.isolateModules(() => {
      process.env.MONITOR_LADDER_PROACTIVE      = '1';
      process.env.MONITOR_LADDER_PROACTIVE_FULL = '1';
      const m = require('../../src/services/monitorService');
      // Zero growth, but proactive full-depth ⇒ a gap-60 band target still fires.
      const d = m._evaluatePositionScheduler(
        makeState(100),
        calmCtx({ waitingCount: 40, seedRise: 0, proactiveOpen: true, proactiveFrac: 1 }),
      );
      expect(d.seedCanFire).toBe(true);
      delete process.env.MONITOR_LADDER_PROACTIVE_FULL;
      delete process.env.MONITOR_LADDER_PROACTIVE;
    });
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
