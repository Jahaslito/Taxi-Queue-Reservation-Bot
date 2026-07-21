/**
 * Fleet-landing true-tail probe (MONITOR_FLEET_PROBE).
 *
 * The probe de-lags SAN's stale displayed queue using our own drivers' landings
 * (a valid lower bound on the true tail, since the morning queue is append-only).
 * These tests assert it (a) brings a fire FORWARD when a fresh landing shows the
 * real tail is higher, (b) never fires early in true-position terms, (c) ignores
 * stale/contaminated landings, and (d) never converts a fire into a skip.
 *
 * The flag is read at module load, so we set it BEFORE requiring monitorService.
 * Jest isolates the module registry per test file, so this stays on for this file
 * only.
 */
process.env.MONITOR_FLEET_PROBE = '1';
const monitor = require('../../src/services/monitorService');
const { _evaluatePositionScheduler, _setFleetLanding } = monitor;

const makeState = (over = {}) => ({
  driverId: 42,
  vehicleNumber: '4007',
  scheduledPosition: 100,
  maxAcceptablePosition: 120,
  state: 'watching',
  hasBeenSeen: false,
  positionFiredToday: false,
  ...over,
});

// lead = min(estimatedDrift 55, POS_MAX_LEAD 10) = 10 ; target 100 ; max 120
// Burst-rate ctx (3.0/s): the growth-scaled lead cap (MONITOR_GROWTH_LEAD,
// 2026-07-19) only bites at calm rates — these probe scenarios are storms.
const baseCtx = {
  waitingCount: 50,
  effectiveGrowthRate: 3.0,
  estimatedDrift: 55,
  biasCorrection: 0,
  horizonSeconds: 55,
  botExecMs: 15000,
  todayDayKey: null,
  botSamplesCount: 5,
  queueShrinkageDetected: false,
};

describe('fleet-landing true-tail probe', () => {
  beforeEach(() => _setFleetLanding(0, 0)); // clear between cases

  test('no fresh landing → unchanged (displayed 50 + lead 10 = 60 < 100 → wait)', () => {
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx });
    expect(d.action).toBe('wait');
  });

  test('fresh landing above display → fire brought forward', () => {
    _setFleetLanding(95, Date.now()); // true tail ~95, display still 50
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx });
    expect(d.action).toBe('fire');
    expect(d.logLine).toMatch(/fleet-probe 50→90/); // capped at waitingCount + 40
  });

  test('stale landing (older than fresh window) → ignored → wait', () => {
    _setFleetLanding(95, Date.now() - 20000);
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx });
    expect(d.action).toBe('wait');
  });

  test('contaminated landing is capped, not trusted verbatim', () => {
    _setFleetLanding(500, Date.now()); // bogus high value (re-add / misread)
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx });
    // effectiveQueue capped at waitingCount(50) + FLEET_PROBE_MAX_LEAD(40) = 90, never 499
    expect(d.logLine).toMatch(/fleet-probe 50→90/);
  });

  test('landing below target−lead → still wait (no early fire ⇒ undershoot ≥ −9 holds)', () => {
    _setFleetLanding(70, Date.now()); // 69 + 10 = 79 < 100
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx });
    expect(d.action).toBe('wait');
  });

  test('displayed queue past max → missed_impossible (probe never rescues OR skips past-max)', () => {
    _setFleetLanding(135, Date.now());
    const d = _evaluatePositionScheduler(makeState(), { ...baseCtx, waitingCount: 130 });
    expect(d.action).toBe('missed_impossible');
  });
});

/**
 * recordFleetLanding must keep the HIGHEST landing in the fresh window, not
 * the latest-by-time. Regression for the 2026-07-04 chunk-step blinding: at
 * the 77→103 step, landings arrived 96,95,93 then straggler 73,71,70 in the
 * same second; latest-wins anchored the probe at 72 and it went blind.
 */
describe('recordFleetLanding — keeps the max true-tail in the fresh window', () => {
  const { _recordFleetLanding, _getFleetLanding, _setFleetLanding } = monitor;
  beforeEach(() => _setFleetLanding(0, 0));

  test('a lower straggler landing does NOT overwrite a fresh higher one', () => {
    _recordFleetLanding(96);            // real tail
    _recordFleetLanding(95);
    _recordFleetLanding(73);            // straggler from an earlier, smaller-queue fire
    _recordFleetLanding(70);
    expect(_getFleetLanding().position).toBe(96); // stays anchored at the tail
  });

  test('a higher landing DOES advance the estimate (tail grew)', () => {
    _recordFleetLanding(96);
    _recordFleetLanding(120);
    expect(_getFleetLanding().position).toBe(120);
  });

  test('once the previous estimate goes stale, a lower landing re-anchors', () => {
    _setFleetLanding(96, Date.now() - 60000); // 60 s old → stale
    _recordFleetLanding(80);
    expect(_getFleetLanding().position).toBe(80); // re-anchors to current reality
  });
});

/**
 * Storm replay through the REAL scheduler — the 2026-06-30 04:36 shape.
 *
 * That morning the displayed queue stepped 62 → 114 in ONE observation (+52),
 * straddling every target in 87–110; all of them fired born-over (+33…+51
 * actual landings). The tail probe / fleet landings provide exactly the
 * intra-chunk samples the stepped display hides. This replays both worlds
 * through _evaluatePositionScheduler and asserts the probe path fires each
 * target while the proven tail is still inside its band — and never fires
 * while the tail is below target−10 (the undershoot contract).
 */
describe('storm replay: +52 display step, targets 87/95/104', () => {
  beforeEach(() => _setFleetLanding(0, 0)); // separate describe — outer reset doesn't apply

  const targets = [87, 95, 104];
  const mkStates = () => targets.map((tgt, i) => makeState({
    driverId: 100 + i,
    vehicleNumber: `T${tgt}`,
    scheduledPosition: tgt,
    maxAcceptablePosition: tgt + 40,
  }));
  const ctxAt = (display) => ({ ...baseCtx, waitingCount: display });
  const runTick = (states, display, fired, t, eff) => {
    for (const s of states) {
      if (s.positionFiredToday) continue;
      const d = _evaluatePositionScheduler(s, ctxAt(display));
      if (d.action === 'fire') {
        s.positionFiredToday = true;
        fired[s.scheduledPosition] = { t, eff };
      }
    }
  };

  test('WITHOUT probe: every straddled target fires born-over on the +52 step', () => {
    const states = mkStates();
    const fired = {};
    for (let t = 0; t <= 5; t++) {
      const display = t < 5 ? 62 : 114;          // the one-step +52 leap
      runTick(states, display, fired, t, display);
    }
    for (const tgt of targets) {
      expect(fired[tgt].t).toBe(5);              // nobody could fire earlier…
      expect(fired[tgt].eff - tgt).toBeGreaterThanOrEqual(10); // …and all born ≥ +10 over
    }
  });

  test('WITH probe: intra-chunk tail samples fire each target in-band, never below target−10', () => {
    const states = mkStates();
    const fired = {};
    // Landings mid-chunk, as the tail probe / fleet landings actually arrive
    // (06-30 real anchors: 85/86 landed BEFORE the display ever showed 114).
    const samples = { 2: 79, 3: 88, 4: 96 };
    for (let t = 0; t <= 5; t++) {
      const display = t < 5 ? 62 : 114;
      if (samples[t]) _setFleetLanding(samples[t], Date.now());
      const eff = samples[t] ? samples[t] - 1 : display;
      runTick(states, display, fired, t, eff);
    }
    // Each target fires DURING the chunk, at the first sample proving its
    // band is reachable — not at the post-chunk display step.
    expect(fired[87]).toEqual({ t: 2, eff: 78 });   // 78+10 ≥ 87 → lands ≈ 79
    expect(fired[95]).toEqual({ t: 3, eff: 87 });
    expect(fired[104]).toEqual({ t: 4, eff: 95 });
    for (const tgt of targets) {
      // undershoot contract: never fired while the proven tail < target−10
      expect(fired[tgt].eff).toBeGreaterThanOrEqual(tgt - 10);
      // in-band reachable: landing ≈ eff+1 inside [target−9, target+10]
      expect(fired[tgt].eff + 1).toBeGreaterThanOrEqual(tgt - 9);
      expect(fired[tgt].eff + 1).toBeLessThanOrEqual(tgt + 10);
    }
  });
});
