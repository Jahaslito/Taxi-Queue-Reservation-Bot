/**
 * Oracle-shadow daily report — position-accuracy ceiling analysis. LOG-ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * After each morning's position window this service replays the day's recorded
 * observations (queue_snapshots) and fires (position_tracking) through three
 * increasingly-constrained models, and logs how far production landed from
 * each ceiling. It never touches live decisions — pure hindsight measurement,
 * the observability half of the ±10 contract work (2026-07-28).
 *
 * The three levels (per the oracle-critique review, 2026-07-28):
 *   1. INDEPENDENT ORACLE — each driver optimized alone against the recorded
 *      trajectory with the day's measured commit latency. Unconstrained
 *      forecasting ceiling; NOT jointly achievable.
 *   2. FLEET ORACLE — all drivers scheduled jointly: one queue slot per driver
 *      (commit order enforced), our own adds re-inflate the counterfactual
 *      queue, clicks rate-limited (ORACLE_SHADOW_CLICKS_PER_SEC), same measured
 *      latency. The meaningful upper bound for existing infrastructure.
 *   3. CAUSAL REPLAY — a policy that sees only PAST observations at each step
 *      (the same stepped/stale stream production saw), scored with own-add
 *      feedback. Two policies: 'reactive10' (production approximation) and
 *      'hardcap' (fire on projection; born-over guard; depth clamped at 25 so
 *      undershoot is bounded at −24; early-fires when projected overshoot
 *      exceeds +40).
 *
 * Gap decomposition the report prints:
 *   independent − fleet   = capacity / fleet-coordination loss
 *   fleet − causal        = forecasting / observability loss
 *   causal − actual       = algorithm implementation loss
 *
 * Assumptions (documented, revisit with shadow-probe data):
 *   • Insertability: SAN stamps adds one-by-one in click-arrival order
 *     (07-27 evidence: 27 competitor slots interleaved within our own 33-fire
 *     batch). Landing = queue-at-commit + 1.
 *   • Commit latency: the day's own median fired_at→landed_at, applied
 *     uniformly (p90 sensitivity row logged alongside).
 *   • The competitor trajectory = observed queue minus our own cumulative
 *     actual adds; counterfactual schedules re-add our adds at their new times.
 *
 * ON/OFF is pure env: MONITOR_ORACLE_SHADOW (default '1' — log-only, one cheap
 * pass per day at ORACLE_SHADOW_HOUR_PT). start() self-gates and never throws.
 */

const db = require('../config/database');

const ENABLED        = (process.env.MONITOR_ORACLE_SHADOW ?? '1') === '1';
const REPORT_HOUR_PT = parseInt(process.env.ORACLE_SHADOW_HOUR_PT ?? '10', 10);
// Click-start rate cap for the fleet oracle (browser click path ≈ 12 browsers /
// ~1.1 s occupancy ≈ 10/s; HTTP-fire raises it — keep the bound conservative).
const CLICKS_PER_SEC = parseInt(process.env.ORACLE_SHADOW_CLICKS_PER_SEC ?? '8', 10);
const BAND = 10;                 // the ±10 contract
const DEPTH_CLAMP = 25;          // hardcap policy: max early depth ⇒ undershoot ≥ −24
const OVERSHOOT_GUARD = 40;      // hardcap policy: fire early rather than exceed this

// ─── Trajectory helpers (pure) ───────────────────────────────────────────────

/** Linear interpolation over samples [{t, q}] sorted by t (t in seconds). */
function interp(traj, t) {
  if (traj.length === 0) return 0;
  if (t <= traj[0].t) return traj[0].q;
  if (t >= traj[traj.length - 1].t) return traj[traj.length - 1].q;
  let lo = 0, hi = traj.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (traj[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = traj[lo], b = traj[hi];
  return b.t === a.t ? b.q : a.q + (b.q - a.q) * (t - a.t) / (b.t - a.t);
}

/**
 * Observed queue minus our own cumulative adds ⇒ competitor-only trajectory.
 * fires: [{tCommit}] (seconds) for fires that actually landed.
 */
function competitorTraj(traj, fires) {
  const commits = fires.map((f) => f.tCommit).filter(Number.isFinite).sort((x, y) => x - y);
  let i = 0, count = 0;
  return traj.map((s) => {
    while (i < commits.length && commits[i] <= s.t) { i++; count++; }
    return { t: s.t, q: Math.max(0, s.q - count) };
  });
}

function scorecard(errs) {
  const n = errs.length;
  if (n === 0) return { n: 0 };
  const inBand = errs.filter((e) => Math.abs(e) <= BAND).length;
  const over40 = errs.filter((e) => e > OVERSHOOT_GUARD).length;
  const sorted = [...errs].sort((a, b) => a - b);
  return {
    n,
    inBandPct:  Math.round(1000 * inBand / n) / 10,
    over40Pct:  Math.round(1000 * over40 / n) / 10,
    worstOver:  Math.max(...errs),
    worstUnder: Math.min(...errs),
    median:     sorted[Math.floor(n / 2)],
  };
}

// ─── Level 1: independent oracle ─────────────────────────────────────────────
// Best click per driver against the OBSERVED trajectory (own adds embedded at
// their real times), latency fixed. Landing floored at queue-at-click + 1.
function independentOracle({ traj, targets, latencyS, stepS = 0.5 }) {
  const t0 = traj[0].t, t1 = traj[traj.length - 1].t;
  return targets.map((target) => {
    let best = null;
    for (let t = t0; t <= t1; t += stepS) {
      const atClick = interp(traj, t) + 1;
      if (atClick - target > BAND) break;          // tail past band: too late forever
      const landed = Math.max(interp(traj, t + latencyS) + 1, atClick);
      const err = Math.round(landed) - target;
      if (best === null || Math.abs(err) < Math.abs(best)) best = err;
      if (best === 0) break;
    }
    return best ?? 999;
  });
}

// ─── Level 2: fleet-constrained oracle ───────────────────────────────────────
// Joint schedule, ascending targets: commit order strictly increasing (one
// queue slot each), our own adds re-inflate the counterfactual queue, click
// starts rate-limited. Latency uniform (day median).
function fleetOracle({ compTraj, targets, latencyS, clicksPerSec = CLICKS_PER_SEC, stepS = 0.5 }) {
  const t0 = compTraj[0].t, t1 = compTraj[compTraj.length - 1].t;
  const sorted = [...targets].sort((a, b) => a - b);
  const clickTimes = [];          // for the rate cap
  const commitTimes = [];         // our counterfactual adds (ascending)
  const errs = [];
  const ownBefore = (t) => {
    let c = 0;
    for (const ct of commitTimes) { if (ct <= t) c++; else break; }
    return c;
  };
  const clicksInWindow = (t) =>
    clickTimes.filter((ct) => ct > t - 1 && ct <= t).length;

  let minClick = t0;
  for (const target of sorted) {
    const prevCommit = commitTimes[commitTimes.length - 1] ?? -Infinity;
    let best = null, bestT = null;
    // 30 s lookback: under click-rate pressure the optimal train shifts EARLIER
    // (bounded undershoot) instead of compressing forward into overshoot.
    for (let t = Math.max(t0, minClick - 30); t <= t1; t += stepS) {
      if (clicksInWindow(t) >= clicksPerSec) continue;         // lane cap
      // evaluate at the CONSTRAINED commit time — commits are ordered, but slot
      // uniqueness comes from own-add feedback (ownBefore), not time spacing:
      // SAN stamps near-simultaneous adds back-to-back in arrival order.
      const tc = Math.max(t + latencyS, prevCommit + 0.001);
      const atClick = interp(compTraj, t) + ownBefore(t) + 1;
      if (atClick - target > BAND && best !== null) break;     // can only get worse
      const landed = Math.max(interp(compTraj, tc) + ownBefore(tc) + 1, atClick);
      const err = Math.round(landed) - target;
      if (best === null || Math.abs(err) < Math.abs(best)) { best = err; bestT = t; }
      if (best === 0) break;
    }
    if (bestT === null) { errs.push(999); continue; }
    clickTimes.push(bestT);
    commitTimes.push(Math.max(bestT + latencyS, prevCommit + 0.001));
    minClick = bestT;             // ascending targets never need earlier bases
    errs.push(best);
  }
  return errs;
}

// ─── Level 3: causal replay ──────────────────────────────────────────────────
// The policy sees samples one at a time (only the past). Fires are scored on
// the full competitor trajectory with own-add feedback.
function causalReplay({ traj, compTraj, targets, latencyS, policy }) {
  const pending = targets.map((target) => ({ target, fired: false, tClick: null }));
  const window = [];              // trailing samples for the rate estimate
  for (const s of traj) {
    window.push(s);
    while (window.length > 2 && s.t - window[0].t > 15) window.shift();
    const dt = s.t - window[0].t;
    const rate = dt >= 2 ? (s.q - window[0].q) / dt : 0;
    for (const p of pending) {
      if (p.fired) continue;
      const projected = s.q + rate * latencyS + 1;
      let fire = false;
      if (policy === 'reactive10') {
        fire = s.q >= p.target - BAND;
      } else { // 'hardcap'
        const deepEnough = s.q >= p.target - DEPTH_CLAMP;      // undershoot ≥ −24
        const onTime     = projected >= p.target - 5;
        const bornOver   = s.q + 1 >= p.target;
        const capBreach  = projected > p.target + OVERSHOOT_GUARD;
        fire = bornOver || (deepEnough && (onTime || capBreach));
      }
      if (fire) { p.fired = true; p.tClick = s.t; }
    }
  }
  // score with own-add feedback, commits in click order
  const fired = pending.filter((p) => p.fired).sort((a, b) => a.tClick - b.tClick);
  const commitTimes = [];
  const results = new Map();
  for (const p of fired) {
    const tc = Math.max(p.tClick + latencyS,
      (commitTimes[commitTimes.length - 1] ?? -Infinity) + 0.25);
    const ownBefore = commitTimes.length;
    commitTimes.push(tc);
    const atClick = interp(compTraj, p.tClick) + ownBefore + 1;
    const landed = Math.max(interp(compTraj, tc) + ownBefore + 1, atClick);
    results.set(p, Math.round(landed) - p.target);
  }
  return pending.map((p) => (p.fired ? results.get(p) : 999));
}

// ─── Data loading + the daily report ─────────────────────────────────────────

/** Date whose PT wall-clock reading is `${dateStr} ${hour}:00` (DST-safe). */
function ptWallToDate(dateStr, hour) {
  let d = new Date(Date.parse(`${dateStr}T00:00:00Z`) + (hour + 7) * 3600e3);
  const got = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  }).format(d)) % 24;
  const diff = ((hour % 24) - got + 36) % 24 - 12;
  if (diff !== 0) d = new Date(d.getTime() + diff * 3600e3);
  return d;
}

async function loadSnapshots(dateStr) {
  const rows = await db('queue_snapshots')
    .whereBetween('observed_at', [ptWallToDate(dateStr, 2), ptWallToDate(dateStr, REPORT_HOUR_PT)])
    .orderBy('observed_at')
    .select('observed_at', 'waiting_count');
  return rows.map((r) => ({ t: new Date(r.observed_at).getTime() / 1000, q: r.waiting_count }));
}

async function loadFires(dateStr) {
  const rows = await db('position_tracking')
    .where('tracking_date', dateStr)
    .whereNotNull('actual_position')
    .select('target_position', 'actual_position', 'fired_at', 'landed_at');
  return rows.map((r) => ({
    target: r.target_position,
    landed: r.actual_position,
    tFire:   r.fired_at   ? new Date(r.fired_at).getTime() / 1000   : null,
    tCommit: r.landed_at  ? new Date(r.landed_at).getTime() / 1000  : null,
  }));
}

function fmt(label, sc) {
  if (!sc || sc.n === 0) return `${label}: n=0`;
  return `${label}: n=${sc.n} ±10=${sc.inBandPct}% >+40=${sc.over40Pct}% ` +
         `worst +${sc.worstOver}/${sc.worstUnder} med=${sc.median >= 0 ? '+' : ''}${sc.median}`;
}

/**
 * One full report for a PT date ('YYYY-MM-DD'). Loaders injectable for tests.
 * Returns the report object (also logged); null when data is insufficient.
 */
async function runDailyReport(dateStr, { snapshots, fires } = {}) {
  const traj = snapshots ?? await loadSnapshots(dateStr);
  const fired = (fires ?? await loadFires(dateStr)).filter((f) => Number.isFinite(f.landed));
  if (traj.length < 10 || fired.length === 0) {
    console.log(`[OracleShadow] ${dateStr}: insufficient data (${traj.length} snapshots, ${fired.length} fires) — skipped`);
    return null;
  }
  const targets = fired.map((f) => f.target);
  const lats = fired
    .map((f) => (f.tCommit && f.tFire ? f.tCommit - f.tFire : null))
    .filter((x) => x !== null && x >= 1 && x <= 60)
    .sort((a, b) => a - b);
  const latMed = lats.length >= 5 ? lats[Math.floor(lats.length / 2)] : 5.0;
  const latP90 = lats.length >= 5 ? lats[Math.floor(lats.length * 0.9)] : 8.0;
  const comp = competitorTraj(traj, fired);

  const report = {
    date: dateStr, fires: fired.length, latencyMedianS: Math.round(latMed * 10) / 10,
    actual:      scorecard(fired.map((f) => f.landed - f.target)),
    independent: scorecard(independentOracle({ traj, targets, latencyS: latMed })),
    fleet:       scorecard(fleetOracle({ compTraj: comp, targets, latencyS: latMed })),
    fleetP90:    scorecard(fleetOracle({ compTraj: comp, targets, latencyS: latP90 })),
    causalReactive: scorecard(causalReplay({ traj, compTraj: comp, targets, latencyS: latMed, policy: 'reactive10' })),
    causalHardcap:  scorecard(causalReplay({ traj, compTraj: comp, targets, latencyS: latMed, policy: 'hardcap' })),
  };
  console.log(`[OracleShadow] ═══ ${dateStr} (commit latency med ${report.latencyMedianS}s) ═══`);
  console.log(`[OracleShadow] ${fmt('ACTUAL           ', report.actual)}`);
  console.log(`[OracleShadow] ${fmt('causal hardcap   ', report.causalHardcap)}`);
  console.log(`[OracleShadow] ${fmt('causal reactive10', report.causalReactive)}`);
  console.log(`[OracleShadow] ${fmt('fleet oracle     ', report.fleet)}`);
  console.log(`[OracleShadow] ${fmt('fleet @p90 lat   ', report.fleetP90)}`);
  console.log(`[OracleShadow] ${fmt('independent      ', report.independent)}`);
  // Gap semantics: the causal rows are a FLOOR for causal policies (raw queue +
  // trailing rate — none of production's bias/probe machinery), so a negative
  // candidate-vs-actual gap means production's extra machinery already beats the
  // naive candidate on this observation stream. The number to close over time is
  // closable-total (actual → fleet ceiling); the causal rows should climb toward
  // the fleet row as observation quality improves (probe feeder).
  console.log(`[OracleShadow] gaps: capacity/coordination=${(report.independent.inBandPct - report.fleet.inBandPct).toFixed(1)}pp ` +
    `closable-total=${(report.fleet.inBandPct - report.actual.inBandPct).toFixed(1)}pp ` +
    `candidate-policy vs actual=${(report.causalHardcap.inBandPct - report.actual.inBandPct).toFixed(1)}pp`);
  return report;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let timer = null;

function msUntilNextReport() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  let next = ptWallToDate(todayStr, REPORT_HOUR_PT);
  if (next <= now) next = new Date(next.getTime() + 24 * 3600e3);
  return next.getTime() - now.getTime();
}

/** Start the daily shadow report. Idempotent, self-gating, never throws. */
function start() {
  if (!ENABLED) {
    console.log('[OracleShadow] disabled (MONITOR_ORACLE_SHADOW=0) — no reports scheduled');
    return;
  }
  if (timer) return;
  const loop = () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    runDailyReport(dateStr).catch((e) => console.error('[OracleShadow] report failed:', e.message));
    timer = setTimeout(loop, msUntilNextReport());
    timer.unref();
  };
  timer = setTimeout(loop, msUntilNextReport());
  timer.unref();
  console.log(`[OracleShadow] scheduled daily at ${REPORT_HOUR_PT}:00 PT (log-only shadow)`);
}

function stop() { if (timer) { clearTimeout(timer); timer = null; } }

module.exports = {
  start, stop, runDailyReport,
  // pure cores, exported for tests
  _interp: interp,
  _competitorTraj: competitorTraj,
  _scorecard: scorecard,
  _independentOracle: independentOracle,
  _fleetOracle: fleetOracle,
  _causalReplay: causalReplay,
  _ptWallToDate: ptWallToDate,
};
