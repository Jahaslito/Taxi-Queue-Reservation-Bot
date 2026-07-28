/**
 * Oracle-shadow report — pure-core tests (no DB; loaders injected).
 *
 * Pins the three ceiling models' safety properties:
 *   • independent oracle finds exact landings on a smooth ramp and degrades to
 *     BOUNDED error when a target is jumped atomically;
 *   • fleet oracle enforces one slot per driver (strictly increasing commits),
 *     re-inflates the counterfactual queue with our own adds, and respects the
 *     click-rate cap;
 *   • causal replay sees only past samples; the 'hardcap' policy bounds
 *     undershoot at −24 by construction and fires early instead of exceeding
 *     +40 projected overshoot;
 *   • runDailyReport wires it together from injected rows and never throws on
 *     thin data.
 *
 * Run: npx jest tests/services/oracleShadow.test.js
 */

const svc = require('../../src/services/oracleShadowService');

/** Linear ramp: q(t) = rate × t, from t=0..dur. Samples every `step` s. */
function ramp({ rate, dur, step = 1, q0 = 0 }) {
  const out = [];
  for (let t = 0; t <= dur; t += step) out.push({ t, q: q0 + rate * t });
  return out;
}

describe('interp + scorecard', () => {
  test('interpolates linearly and clamps at both ends', () => {
    const traj = [{ t: 0, q: 0 }, { t: 10, q: 100 }];
    expect(svc._interp(traj, 5)).toBe(50);
    expect(svc._interp(traj, -5)).toBe(0);
    expect(svc._interp(traj, 99)).toBe(100);
  });

  test('scorecard computes band, cap violations and extremes', () => {
    const sc = svc._scorecard([0, 5, -10, 11, 41, -25]);
    expect(sc.n).toBe(6);
    expect(sc.inBandPct).toBe(50);          // 0, 5, −10
    expect(sc.over40Pct).toBeCloseTo(16.7, 0); // just 41
    expect(sc.worstOver).toBe(41);
    expect(sc.worstUnder).toBe(-25);
  });
});

describe('independent oracle', () => {
  test('lands exactly on target on a smooth ramp', () => {
    const traj = ramp({ rate: 5, dur: 120 });          // storm-speed, smooth
    const errs = svc._independentOracle({ traj, targets: [100, 200, 300], latencyS: 5 });
    for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(1);
  });

  test('atomic jump past a target degrades to bounded error, never 999', () => {
    // queue sits at 40, then jumps 40→160 in one sample: target 100 is jumped
    const traj = [{ t: 0, q: 40 }, { t: 60, q: 40 }, { t: 61, q: 160 }, { t: 120, q: 160 }];
    const [err] = svc._independentOracle({ traj, targets: [100], latencyS: 5 });
    expect(err).not.toBe(999);
    expect(Math.abs(err)).toBeLessThanOrEqual(60);     // best click brackets the jump
  });
});

describe('fleet-constrained oracle', () => {
  test('feasible ramp: every driver in band despite joint constraints', () => {
    const compTraj = ramp({ rate: 4, dur: 200 });
    const targets = [80, 90, 100, 110, 120, 130];
    const errs = svc._fleetOracle({ compTraj, targets, latencyS: 5, clicksPerSec: 8 });
    for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(10);
  });

  test('own adds shift later drivers: dense cluster still one slot each', () => {
    const compTraj = ramp({ rate: 4, dur: 200 });
    // 8 drivers all wanting 100 — only distinct slots exist; ±10 gives 21 slots
    const targets = Array(8).fill(100);
    const errs = svc._fleetOracle({ compTraj, targets, latencyS: 5, clicksPerSec: 8 });
    expect(errs.filter((e) => Math.abs(e) <= 10).length).toBe(8);
    // landings = target+err must be 8 DISTINCT slots
    const landings = errs.map((e, i) => 100 + e).sort((a, b) => a - b);
    expect(new Set(landings).size).toBe(8);
  });

  test('click-rate cap: spaced targets stay in band; tight cluster stays bounded', () => {
    // Feasible under the cap: 20 targets spanning 190 positions at 6/s needs
    // ~32 s of commits; a 2/s click cap only needs 10 s — no loss expected.
    const compTraj = ramp({ rate: 6, dur: 300 });
    const spaced = Array.from({ length: 20 }, (_, i) => 200 + i * 10);
    for (const e of svc._fleetOracle({ compTraj, targets: spaced, latencyS: 5, clicksPerSec: 2 })) {
      expect(Math.abs(e)).toBeLessThanOrEqual(10);
    }
    // Physically INFEASIBLE cluster (20 slots in a 19-wide corridor at 2
    // clicks/s): the lookback centers the train — loss stays bounded and
    // roughly symmetric instead of compressing into pure overshoot.
    const cluster = Array.from({ length: 20 }, (_, i) => 500 + i);
    const errs = svc._fleetOracle({ compTraj, targets: cluster, latencyS: 5, clicksPerSec: 2 });
    for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(60);
    const median = [...errs].sort((a, b) => a - b)[10];
    expect(Math.abs(median)).toBeLessThanOrEqual(20);
  });
});

describe('causal replay', () => {
  test('reactive10 fires only after observing the trigger (only-past info)', () => {
    // quiet at 80 for 60 s, then a surprise chunk sweeps to 300 in 10 s
    const traj = [
      ...ramp({ rate: 0, dur: 60, q0: 80 }),
      ...ramp({ rate: 22, dur: 10, step: 1, q0: 80 }).map((s) => ({ t: s.t + 60, q: s.q })),
      { t: 80, q: 300 }, { t: 200, q: 300 },
    ];
    const errs = svc._causalReplay({
      traj, compTraj: traj, targets: [150], latencyS: 5, policy: 'reactive10',
    });
    // fires reactively into the sweep → overshoots (this is today's failure mode)
    expect(errs[0]).toBeGreaterThan(10);
  });

  test('hardcap bounds undershoot at −24 by construction', () => {
    // slow ramp then a monster projected chunk: the guard fires early
    const traj = ramp({ rate: 12, dur: 100 });
    const errs = svc._causalReplay({
      traj, compTraj: traj, targets: [200, 400, 600], latencyS: 5, policy: 'hardcap',
    });
    for (const e of errs) {
      expect(e).not.toBe(999);
      expect(e).toBeGreaterThanOrEqual(-24);
    }
  });

  test('hardcap born-over guard: target crossed while quiet ⇒ immediate fire', () => {
    const traj = [
      { t: 0, q: 90 }, { t: 5, q: 90 },
      { t: 10, q: 130 },              // target 100 crossed between samples
      ...ramp({ rate: 0, dur: 100, q0: 130 }).map((s) => ({ t: s.t + 10, q: s.q })),
    ];
    const errs = svc._causalReplay({
      traj, compTraj: traj, targets: [100], latencyS: 5, policy: 'hardcap',
    });
    // fired on the first sample showing the cross; queue then flat ⇒ bounded
    expect(errs[0]).toBeGreaterThan(10);       // born-over cannot be in-band…
    expect(errs[0]).toBeLessThanOrEqual(31);   // …but is bounded by the flat tail
  });
});

describe('competitorTraj + runDailyReport wiring', () => {
  test('subtracts our own cumulative adds from the observed queue', () => {
    const traj = [{ t: 0, q: 10 }, { t: 10, q: 20 }, { t: 20, q: 30 }];
    const comp = svc._competitorTraj(traj, [{ tCommit: 5 }, { tCommit: 15 }]);
    expect(comp.map((s) => s.q)).toEqual([10, 19, 28]);
  });

  test('runDailyReport produces scorecards + gaps from injected rows', async () => {
    const snapshots = ramp({ rate: 3, dur: 600, q0: 20 })
      .map((s) => ({ t: s.t + 1_700_000_000, q: s.q }));
    const fires = [
      { target: 200, landed: 230, tFire: 1_700_000_060, tCommit: 1_700_000_066 },
      { target: 400, landed: 415, tFire: 1_700_000_125, tCommit: 1_700_000_131 },
      { target: 800, landed: 802, tFire: 1_700_000_258, tCommit: 1_700_000_264 },
      { target: 900, landed: 911, tFire: 1_700_000_291, tCommit: 1_700_000_297 },
      { target: 950, landed: 958, tFire: 1_700_000_308, tCommit: 1_700_000_314 },
    ];
    const report = await svc.runDailyReport('2026-07-28', { snapshots, fires });
    expect(report).not.toBeNull();
    expect(report.actual.n).toBe(5);
    expect(report.independent.inBandPct).toBeGreaterThanOrEqual(report.fleet.inBandPct);
    expect(report.fleet.n).toBe(5);
    expect(report.causalHardcap.n).toBe(5);
  });

  test('runDailyReport skips gracefully on thin data', async () => {
    const report = await svc.runDailyReport('2026-07-28', { snapshots: [], fires: [] });
    expect(report).toBeNull();
  });
});

describe('PT wall-clock helper', () => {
  test('maps a July date to 10:00 PDT (17:00 UTC)', () => {
    const d = svc._ptWallToDate('2026-07-28', 10);
    expect(d.toISOString()).toBe('2026-07-28T17:00:00.000Z');
  });
  test('maps a January date to 10:00 PST (18:00 UTC)', () => {
    const d = svc._ptWallToDate('2026-01-15', 10);
    expect(d.toISOString()).toBe('2026-01-15T18:00:00.000Z');
  });
});
