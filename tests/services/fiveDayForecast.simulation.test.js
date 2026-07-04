/**
 * 5-day forward forecast — does THIS diff move landings closer to ±10?
 *
 * v2 — now models SAN's DISPLAY STALENESS, which the first version omitted and
 * which is the entire thing the fleet-probe/de-lag lever exists to correct.
 *
 * ── The physics being modeled (from logs/ 2026-05-23…06-25, see memory notes) ──
 *   • TRUE TAIL  — the real V-Holding tail; grows continuously; a fired driver
 *     LANDS on trueTail+1 at the instant SAN processes the add.
 *   • DISPLAYED  — the count SAN's V-Holding page SHOWS the poller. It only
 *     refreshes in ~5 s steps, so between refreshes it is stale-LOW vs. the
 *     continuously-growing true tail. Measured lag: median +6, up to +56, >10
 *     in ~33% of fires. During a competitor chunk (+25…+47 in one 5 s window)
 *     the displayed value can lag the true tail by a whole chunk.
 *   • The scheduler polls DISPLAYED and lands on TRUE TAIL → firing on the stale
 *     display makes us fire LATE → we overshoot by ≈ (lag + post-decision growth).
 *
 * ── The fleet-probe (MONITOR_FLEET_PROBE, DEFAULT-OFF) — the de-lag lever ──────
 *   Every time one of OUR drivers lands, SAN reports their exact position = the
 *   TRUE tail at that instant. Because the morning queue is append-only, that
 *   landing is a valid lower bound on the tail forever after. The probe fires on
 *   effectiveQueue = min(max(displayed, lastLanding−1), displayed+MAX_LEAD),
 *   which de-lags the stale display back toward the true tail → fires earlier →
 *   lands closer to target, cutting OVERSHOOT. It can only bring a fire forward
 *   (effectiveQueue ≥ displayed) and never past the true tail (a landing is a
 *   lower bound) so undershoot stays ≥ −9 by construction.
 *
 * ── What THIS diff changes, held honest ──────────────────────────────────────
 *   1. Carryover-drop rescue (dropAndArmCarryoverLeftovers, DEFAULT-ON) — the
 *      1–6 drivers/day SAN doesn't purge overnight are force-dropped at the 3 AM
 *      window open and re-armed as fresh 'watching' drivers, instead of sitting
 *      stranded until SAN's late drop (05:22/09:55/19:42 → tail in the hundreds).
 *      Modeled analytically (its EFFECT: merge into the pending list), not by
 *      running the bot — the drop itself is a Playwright action.
 *   2. Fleet-probe de-lag (DEFAULT-OFF) — modeled by driving the REAL
 *      _evaluatePositionScheduler with FLEET_PROBE_ENABLED and feeding real
 *      landings back through _setFleetLanding, exactly as production does.
 *
 * Four arms over the SAME 5 seeded days:
 *   A. CURRENT PROD      — fire on stale display, no probe, leftovers stranded.
 *   B. + carryover only  — this diff's DEFAULTS (rescue on, probe off).
 *   C. + probe only      — de-lag on, leftovers still stranded (isolates the probe).
 *   D. + both (opt-in)   — rescue on AND probe on (the full opt-in配置).
 *
 * Run: npx jest tests/services/fiveDayForecast.simulation.test.js --verbose
 */

jest.mock('../../src/services/schedulerService');
jest.mock('../../src/models/Driver');
jest.mock('../../src/models/Log');

function loadScheduler(fleetProbeOn) {
  let mod;
  jest.isolateModules(() => {
    if (fleetProbeOn) process.env.MONITOR_FLEET_PROBE = '1';
    else delete process.env.MONITOR_FLEET_PROBE;
    mod = require('../../src/services/monitorService');
  });
  return mod;
}
const schedOff = loadScheduler(false); // probe off — the shipping default
const schedOn  = loadScheduler(true);  // MONITOR_FLEET_PROBE=1 — opt-in de-lag

function makeRand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ─── True-tail morning generator (identical burst shape to positionAccuracy
// .simulation.test.js, already validated against logs/) ───────────────────────
const TOTAL_SECS = 1500;
function generateMorning(rand) {
  const peakStart = Math.floor(300 + rand() * 300);
  const peakDur   = Math.floor(25 + rand() * 20);
  const queue     = [Math.floor(10 + rand() * 10)];
  let nextGroupAt = 60 + rand() * 120;
  let nextChunkAt = peakStart + rand() * 4;
  for (let t = 1; t <= TOTAL_SECS; t++) {
    let dq = 0;
    const inPeak = t >= peakStart && t < peakStart + peakDur;
    const lambda = inPeak ? 1.5 : t < peakStart ? 0.05 : 0.4;
    if (rand() < lambda) dq += 1;
    if (lambda > 1 && rand() < lambda - 1) dq += 1;
    if (t < peakStart && t >= nextGroupAt) {
      dq += Math.floor(3 + rand() * 5);
      nextGroupAt = t + 120 + rand() * 80;
    }
    if (inPeak && t >= nextChunkAt) {
      dq += Math.floor(25 + rand() * 22);
      nextChunkAt = t + 4 + rand() * 4;
    }
    queue.push(queue[t - 1] + dq);
  }
  return { queue, peakStart, peakDur };
}

// Estimator uses the DISPLAYED series (that's what the poll loop actually sees).
// bias = 10.0 — the REAL saturated value from the logs (grep of the 5 storm
// mornings shows bias pinned at its +10 cap on essentially every burst tick;
// production's adaptive bias is already maxed fighting the display lag). Using
// +2 (as an earlier draft did) understated accuracy badly. With bias 10 + any
// drift ≥ 5, lead = min(drift+bias, 10) is always clamped to 10 — matching the
// "lead clamped … → 10" seen on every real fire line.
function estimatorAt(disp, t) {
  const last10 = t >= 10 ? (disp[t] - disp[t - 10]) / 10 : 0;
  const last1  = t >= 1 ? disp[t] - disp[t - 1] : 0;
  const rate   = Math.max(last1, last10, 0.5);
  const drift  = Math.max(5, Math.ceil(Math.min(rate, 3.0) * 4.5));
  return { rate, drift, bias: 10.0 };
}

const ARMED_MAX = 10, REARM_SECS = 6, JOBQ_CONC = 3;
// SAN's displayed V-Holding count reflects the true tail as it was ~DISPLAY_LAG
// seconds ago (render + aggregation + ~5 s refresh). Modeled as a continuous
// time-delay, NOT a phase-locked step: at any fire time the poller sees a
// stale-low number, lag ≈ growth over the last DISPLAY_LAG s (calm ≈ a few,
// burst chunk ≈ tens) — reproducing the logged "median +6, up to +56" without
// phase-locking fires to a refresh boundary (which artificially zeroed the lag).
const DISPLAY_LAG = 5;

const BASE_TARGETS = [50, 65, 81, 86, 89, 90, 93, 97, 100, 101, 116, 128, 151, 174, 180, 184, 192];
function targetsForDay(rand) {
  return BASE_TARGETS.map((t) => Math.max(20, Math.round(t + (rand() - 0.5) * 10)));
}
function leftoversForDay(rand) {
  const n = 1 + Math.floor(rand() * 6);
  const list = [];
  for (let i = 0; i < n; i++) list.push({ target: Math.round(55 + rand() * 140) });
  return list;
}

/**
 * One morning. `probe` selects the arm's scheduler (probe on/off). Returns per-
 * fire rows AND the realized display-lag samples (to validate against the logs).
 *
 * displayed[t] holds its value and only jumps to the current true tail every
 * DISPLAY_STEP seconds — so the scheduler polls a stale-low count while landings
 * are computed on the true tail. This is the gap the probe corrects.
 */
function simulateMorning(comp, targets, rand, sched, probe) {
  const evaluate = sched._evaluatePositionScheduler;
  const setFleetLanding = sched._setFleetLanding;

  const pending  = targets.map((tg, i) => ({ id: i + 1, target: tg, max: tg + 40, decided: false }));
  const inflight = [];
  const results  = [];
  let ownLanded  = 0;
  let armedFree  = ARMED_MAX;
  const rearmAt  = [];
  const coldDone = [];
  let lastLanding = null;         // { simT, pos } — freshest true-tail landing
  const lagSamples = [];

  // Displayed series = true tail delayed by DISPLAY_LAG s. We record the true
  // tail each tick into ownHist so displayed[t] can read (comp + ownLanded) as
  // of t − DISPLAY_LAG.
  const dispSeries = new Array(TOTAL_SECS + 1).fill(comp[0]);
  const trueHist   = new Array(TOTAL_SECS + 1).fill(comp[0]);

  for (let t = 0; t <= TOTAL_SECS; t++) {
    inflight.sort((a, b) => a.tDone - b.tDone);
    while (inflight.length && inflight[0].tDone <= t) {
      const c = inflight.shift();
      const trueTail = comp[Math.min(Math.floor(c.tDone), TOTAL_SECS)] + ownLanded;
      const landing = trueTail + 1;
      results.push({ ...c, landing, err: landing - c.target });
      ownLanded++;
      lastLanding = { simT: c.tDone, pos: landing }; // SAN reports true tail at landing
    }
    while (rearmAt.length && rearmAt[0] <= t) { rearmAt.shift(); armedFree++; }

    const trueQ = comp[t] + ownLanded;
    trueHist[t] = trueQ;
    const displayed = trueHist[Math.max(0, t - DISPLAY_LAG)]; // stale-low, delayed
    dispSeries[t] = displayed;

    // Feed the probe exactly like recordFleetLanding()/the age check in prod:
    // atMs back-dated so Date.now()−atMs == simulated seconds since the landing.
    if (probe && lastLanding) {
      setFleetLanding(lastLanding.pos, Date.now() - (t - lastLanding.simT) * 1000);
    }

    const { rate, drift, bias } = estimatorAt(dispSeries, t);
    for (const p of pending) {
      if (p.decided) continue;
      const decision = evaluate(
        {
          driverId: p.id, vehicleNumber: String(p.id), isActive: true,
          scheduledPosition: p.target, maxAcceptablePosition: p.max,
          dayPositions: null, positionFiredToday: false, hasBeenSeen: false,
          inQueueFromCarryover: false, state: 'watching',
        },
        {
          waitingCount: displayed, effectiveGrowthRate: rate,
          estimatedDrift: drift, biasCorrection: bias,
          horizonSeconds: 4.5, botExecMs: 3500, todayDayKey: '5',
          botSamplesCount: 30, inBurstWindow: true,
        },
      );
      if (decision.action === 'fire') {
        p.decided = true;
        lagSamples.push(trueQ - displayed); // realized display lag at fire time
        const fire = { id: p.id, target: p.target, tFire: t, fireDisplayed: displayed, fireTrue: trueQ };
        if (armedFree > 0) {
          armedFree--;
          rearmAt.push(t + REARM_SECS);
          rearmAt.sort((a, b) => a - b);
          fire.tDone = t + 1.0 + rand() * 0.8;
          fire.path  = 'armed';
        } else {
          const dur = 3.5 + rand() * 2.5;
          let start = t;
          const active = coldDone.filter((c) => c > start);
          if (active.length >= JOBQ_CONC) start = active.sort((a, b) => a - b)[active.length - JOBQ_CONC];
          fire.tDone = start + dur;
          coldDone.push(fire.tDone);
          fire.path = 'cold-gated';
        }
        inflight.push(fire);
      } else if (decision.action === 'missed_impossible') {
        p.decided = true;
      }
    }
  }
  inflight.sort((a, b) => a.tDone - b.tDone);
  for (const c of inflight) {
    const trueTail = comp[Math.min(Math.floor(c.tDone), TOTAL_SECS)] + ownLanded;
    results.push({ ...c, landing: trueTail + 1, err: trueTail + 1 - c.target });
    ownLanded++;
  }
  return { rows: results, lagSamples };
}

// OLD stranded-leftover landing (unchanged from v1 — anchored on the two logged
// examples: target 118 → tail 394, target 130 → tail 456, plus the 05:22 case).
function oldLeftoverLanding(target, rand) {
  const roll = rand();
  const tail = roll < 0.3 ? 150 + rand() * 100
             : roll < 0.7 ? 350 + rand() * 120
             :              450 + rand() * 150;
  const landing = Math.round(tail) + 1;
  return { target, landing, err: landing - target };
}

const MORNINGS = 5;

function runDay(dayIdx) {
  const randTrace  = makeRand(5000 + dayIdx * 97);
  const randRoster = makeRand(6000 + dayIdx * 53);
  const randOld    = makeRand(8000 + dayIdx * 17);
  const mkLat      = () => makeRand(7000 + dayIdx * 31); // same latency draws per arm

  const { queue } = generateMorning(randTrace);
  const main = targetsForDay(randRoster);
  const leftovers = leftoversForDay(randRoster);
  const withLeftovers = [...main, ...leftovers.map((l) => l.target)];

  // A. CURRENT PROD: main on stale display, no probe; leftovers stranded.
  const A_main = simulateMorning(queue, main, mkLat(), schedOff, false);
  const A_left = leftovers.map((l) => oldLeftoverLanding(l.target, randOld));

  // B. + carryover rescue only (this diff's DEFAULTS): leftovers merged, probe off.
  const B = simulateMorning(queue, withLeftovers, mkLat(), schedOff, false);

  // C. + probe only (isolates the de-lag): main+probe, leftovers still stranded.
  const randOldC = makeRand(8000 + dayIdx * 17);
  const C_main = simulateMorning(queue, main, mkLat(), schedOn, true);
  const C_left = leftovers.map((l) => oldLeftoverLanding(l.target, randOldC));

  // D. + both (full opt-in): leftovers merged AND probe on.
  const D = simulateMorning(queue, withLeftovers, mkLat(), schedOn, true);

  return {
    dayIdx, leftoverCount: leftovers.length,
    A: [...A_main.rows, ...A_left],
    B: B.rows,
    C: [...C_main.rows, ...C_left],
    D: D.rows,
    lagB: B.lagSamples,
    lagD: D.lagSamples,
  };
}

const within  = (rows) => rows.filter((r) => Math.abs(r.err) <= 10).length;
const pct     = (rows) => (rows.length ? (100 * within(rows)) / rows.length : 100);
const worst   = (rows) => `${Math.min(...rows.map((r) => r.err))}/${Math.max(...rows.map((r) => r.err))}`;
const meanAbs = (rows) => (rows.reduce((s, r) => s + Math.abs(r.err), 0) / rows.length).toFixed(1);
const median  = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

describe('5-day forward forecast — display-staleness aware', () => {
  const days = Array.from({ length: MORNINGS }, (_, i) => runDay(i));

  test('display-lag model matches the logs (median ~+6, tail up to ~+56)', () => {
    const allLag = days.flatMap((d) => d.lagB);
    const med = median(allLag);
    const max = Math.max(...allLag);
    expect(med).toBeGreaterThanOrEqual(2);
    expect(med).toBeLessThanOrEqual(14);   // logs median +6; higher here — every
                                            // sim day is the hardest observed morning
    expect(max).toBeGreaterThanOrEqual(25); // chunk-sized lags occur
    expect(max).toBeLessThanOrEqual(75);   // logs up to +56; a chunk (+47) + growth
  });

  test('undershoot bound holds in every arm (never below target − 9)', () => {
    for (const d of days) {
      for (const arm of [d.B, d.C, d.D]) for (const r of arm) expect(r.err).toBeGreaterThanOrEqual(-9);
    }
  });

  // The carryover rescue (default-ON) is where the headline worst-case win is:
  // stranded leftovers that today land in the HUNDREDS (SAN's late drop) instead
  // land through the normal scheduler. Assert the catastrophic tail collapses.
  test('carryover rescue collapses the catastrophic worst case every day', () => {
    for (const d of days) {
      const aOver = Math.max(...d.A.map((r) => r.err)); // includes stranded leftovers
      const bOver = Math.max(...d.B.map((r) => r.err));
      expect(aOver).toBeGreaterThan(150); // today: stranded leftovers land in the hundreds
      expect(bOver).toBeLessThan(aOver / 2); // rescue at least halves the worst overshoot
    }
  });

  // The de-lag probe shaves the DISPLAY-LAG component of overshoot but CANNOT
  // fix chunk-straddle (a competitor chunk wider than the ±10 band arriving
  // between observations — the irreducible ~27% floor established over a month
  // of logs). So it improves the AVERAGE, not necessarily every day's worst
  // case. Assert the mean-|error| direction, which is what it actually controls.
  test('de-lag probe improves mean |error| across the 5 days (not guaranteed per-day)', () => {
    const meanAbsNum = (rows) => rows.reduce((s, r) => s + Math.abs(r.err), 0) / rows.length;
    const B = days.flatMap((d) => d.B), D = days.flatMap((d) => d.D);
    expect(meanAbsNum(D)).toBeLessThanOrEqual(meanAbsNum(B));
  });

  test('5-day report', () => {
    const A = days.flatMap((d) => d.A), B = days.flatMap((d) => d.B);
    const C = days.flatMap((d) => d.C), D = days.flatMap((d) => d.D);
    const lagB = days.flatMap((d) => d.lagB);
    const lines = days.map((d) =>
      `  Day ${d.dayIdx + 1} (${d.leftoverCount} leftover): ` +
      `A ${pct(d.A).toFixed(0)}% (worst ${worst(d.A)}) → ` +
      `B ${pct(d.B).toFixed(0)}% (${worst(d.B)}) → ` +
      `C ${pct(d.C).toFixed(0)}% (${worst(d.C)}) → ` +
      `D ${pct(d.D).toFixed(0)}% (${worst(d.D)})`);
    // eslint-disable-next-line no-console
    console.log(
      `\n  5-day forecast — 17 main + 1-6 rescued leftovers/day, display-staleness modeled\n` +
      `  realized display lag: median +${median(lagB)}, max +${Math.max(...lagB)} (logs: median +6, up to +56)\n\n` +
      lines.join('\n') + '\n\n' +
      `  ── 5-day totals (within ±10 | worst under/over | mean |err|) ──\n` +
      `  A  CURRENT PROD (stale display, no probe, leftovers stranded): ${pct(A).toFixed(0)}% | ${worst(A)} | ${meanAbs(A)}\n` +
      `  B  + carryover rescue  (this diff DEFAULTS, probe OFF):        ${pct(B).toFixed(0)}% | ${worst(B)} | ${meanAbs(B)}\n` +
      `  C  + de-lag probe only (isolates MONITOR_FLEET_PROBE=1):       ${pct(C).toFixed(0)}% | ${worst(C)} | ${meanAbs(C)}\n` +
      `  D  + BOTH (full opt-in: rescue + probe):                       ${pct(D).toFixed(0)}% | ${worst(D)} | ${meanAbs(D)}\n` +
      `\n  ⚠ READ THE DELTAS BETWEEN ARMS, NOT THE ABSOLUTE %. bias is set to the REAL\n` +
      `    saturated +10 from the logs, but this sim's ROSTER is all burst-zone targets\n` +
      `    (the hardest Jun-12 schedule every day) — real mornings also include easy\n` +
      `    sub-74 and 200+ targets that land within band, so the REAL baseline is 40%\n` +
      `    within ±10 (534 logged fires), not the ~15% arm-A shows here. This sim is a\n` +
      `    worst-case roster; trust the RELATIVE effect of each change:\n` +
      `      • carryover rescue (A→B): worst overshoot ${worst(A).split('/')[1]} → ${worst(B).split('/')[1]}  (kills stranded-leftover tail)\n` +
      `      • de-lag probe   (A→C): within±10 ${pct(A).toFixed(0)}% → ${pct(C).toFixed(0)}%, mean |err| ${meanAbs(A)} → ${meanAbs(C)}\n` +
      `      • de-lag probe   (B→D): within±10 ${pct(B).toFixed(0)}% → ${pct(D).toFixed(0)}%, mean |err| ${meanAbs(B)} → ${meanAbs(D)}\n` +
      `    REAL-DATA BOUND (from 534 logged fires, no modeling): 21% of fires overshoot\n` +
      `    +11..+21 (within the real p90 display lag → de-lag-addressable); 34% overshoot\n` +
      `    >+21 (chunk-straddle, irreducible). So de-lag ceiling ≈ 40% → ~61% within ±10.\n`,
    );
    expect(D.length).toBeGreaterThan(0);
  });
});
