#!/usr/bin/env node
/**
 * Position-accuracy GOAL REPORT — the production yardstick for the
 * "overshoot consistently ≤ +15, undershoot never below −10" contract.
 *
 * Reads daily log file(s) and emits per-morning metrics + a PASS/FAIL
 * verdict, so "consistent" is a measurement, not an impression:
 *
 *   PASS = zero landings below target−10  AND  p90 of landing error ≤ +15
 *
 * Usage:
 *   node scripts/positionGoalReport.js logs/2026-07-05.log [more.log …]
 *   node scripts/positionGoalReport.js logs/2026-07-*.log
 *
 * Also surfaces the diagnostics that explain a miss: cold fires (should be
 * ZERO after the armed-pool fix), armed-path share, tail-probe samples and
 * fleet-probe activations (should be >0 on storm mornings once the flags are
 * on), and per-fire rows for anything outside ±15.
 */
const fs = require('fs');

const RE_TS   = /\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) PT\]/;
const RE_FIRE = /\[Pos\] #(\S+) — ✓ queue (\d+) \+ lead [\d.]+.*?≥ target (\d+) \(/;
const RE_ARM  = /\[Arm\] ⚡ #(\S+) fired via armed session in (\d+) ms/;
const RE_LAND = /\[PosTracking\] #(\S+) landed at (\d+)/;
const RE_TPS  = /\[TailProbe\] tail sample: (\d+)/;
const RE_FLP  = /\[fleet-probe (\d+)→(\d+)/;

const secs = (m) => (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
const pct  = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const q    = (sorted, p) =>
  sorted.length ? sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)] : 0;

let anyFail = false;

for (const path of process.argv.slice(2)) {
  let text;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch (e) { console.error(`${path}: ${e.message}`); continue; }

  const fires = [], lands = new Map(), arms = new Map();
  let tailSamples = 0, fleetProbeHits = 0, day = path;

  for (const line of text.split('\n')) {
    const ts = RE_TS.exec(line);
    if (!ts) continue;
    day = ts[1];
    let m;
    if ((m = RE_FIRE.exec(line))) {
      fires.push({ veh: m[1], t: secs(ts), q: +m[2], tgt: +m[3] });
    } else if ((m = RE_LAND.exec(line))) {
      if (!lands.has(m[1])) lands.set(m[1], []);
      lands.get(m[1]).push({ t: secs(ts), pos: +m[2] });
    } else if ((m = RE_ARM.exec(line))) {
      if (!arms.has(m[1])) arms.set(m[1], []);
      arms.get(m[1]).push(secs(ts));
    } else if (RE_TPS.test(line)) {
      tailSamples++;
    } else if (RE_FLP.test(line)) {
      fleetProbeHits++;
    }
  }

  const rows = [];
  for (const f of fires) {
    const landing = (lands.get(f.veh) || []).find((l) => l.t >= f.t && l.t <= f.t + 600);
    if (!landing) continue; // eligibility-failed accounts (#142 class) — data issue, tracked separately
    const armed = (arms.get(f.veh) || []).some((t) => t >= f.t && t <= f.t + 120);
    rows.push({ ...f, landed: landing.pos, err: landing.pos - f.tgt, armed });
  }

  if (rows.length === 0) {
    console.log(`\n── ${day} (${path}) — no position fires with landings (dev log or quiet day)`);
    continue;
  }

  const errs      = rows.map((r) => r.err).sort((a, b) => a - b);
  const overs     = errs.filter((e) => e > 10);
  const le15      = errs.filter((e) => e <= 15).length;
  const underViol = rows.filter((r) => r.err < -10);
  const cold      = rows.filter((r) => !r.armed);
  const p90       = q(errs, 0.9);
  const pass      = underViol.length === 0 && p90 <= 15;
  if (!pass) anyFail = true;

  console.log(`\n── ${day} — ${rows.length} fires ──────────────────────────────`);
  console.log(`   within ±10: ${pct(rows.length - overs.length - underViol.length, rows.length)}   ≤ +15: ${pct(le15, rows.length)}   err p50/p90/max: ${q(errs, 0.5) >= 0 ? '+' : ''}${q(errs, 0.5)}/${p90 >= 0 ? '+' : ''}${p90}/${Math.max(...errs) >= 0 ? '+' : ''}${Math.max(...errs)}   min: ${Math.min(...errs)}`);
  console.log(`   armed path: ${pct(rows.length - cold.length, rows.length)} (${cold.length} cold — target 0)   tail-probe samples: ${tailSamples}   fleet-probe activations: ${fleetProbeHits}`);
  console.log(`   VERDICT: ${pass ? '✅ PASS' : '❌ FAIL'} — undershoot<−10: ${underViol.length} (must be 0), p90 ${p90 >= 0 ? '+' : ''}${p90} (must be ≤ +15)`);

  const outliers = rows.filter((r) => r.err > 15 || r.err < -10)
                       .sort((a, b) => b.err - a.err);
  if (outliers.length) {
    console.log('   outside the contract band:');
    for (const r of outliers) {
      console.log(`     #${r.veh}  target ${r.tgt}  fired@q${r.q}  landed ${r.landed}  err ${r.err >= 0 ? '+' : ''}${r.err}  (${r.armed ? 'armed' : 'COLD'})`);
    }
  }
}

process.exitCode = anyFail ? 1 : 0;
