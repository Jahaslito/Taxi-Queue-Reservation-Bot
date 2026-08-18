#!/usr/bin/env node
// Per-day storm anatomy: batch structure, commit latency, drift-during-commit
// vs applied lead — the decomposition err = commitDrift − effectiveLead.
const fs = require('fs');

const RE_TS   = /\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) PT\]/;
const RE_FIRE = /\[Pos\] #(\S+) — ✓ queue (\d+) \+ lead ([\d.]+)(.*?)≥ target (\d+) \(/;
const RE_ONSET= /\[Pos\] #(\S+) — ⚡ ONSET early fire: queue (\d+).*?target (\d+)/;
const RE_FAST = /\[Arm\] ⚡ #(\S+) fast-released at \d+ ms, add COMMITTED → position (\d+) \(.*?, (\d+) ms total\)/;
const RE_LAND = /\[PosTracking\] #(\S+) landed at (\d+)/;
const RE_PRED = /\[pred-lead (\d+) = clamp\([\d.]+\+[\d.]+×(\d+) inflight/;

const secs = (m) => (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
const qtl = (arr, p) => { const s = [...arr].sort((a,b)=>a-b); return s.length ? s[Math.min(Math.floor(s.length*p), s.length-1)] : NaN; };

for (const path of process.argv.slice(2)) {
  const text = fs.readFileSync(path, 'utf8');
  const fires = []; const lands = new Map(); const commits = new Map();
  let day = path;
  for (const line of text.split('\n')) {
    const ts = RE_TS.exec(line); if (!ts) continue; day = ts[1];
    let m;
    if ((m = RE_FIRE.exec(line))) {
      const pm = RE_PRED.exec(line);
      fires.push({ veh: m[1], t: secs(ts), q: +m[2], lead: +m[3], tgt: +m[5],
                   pred: !!pm, inflight: pm ? +pm[2] : null, clamped: /lead clamped/.test(line) });
    } else if ((m = RE_ONSET.exec(line))) {
      fires.push({ veh: m[1], t: secs(ts), q: +m[2], lead: 0, tgt: +m[3], pred: false, inflight: null, clamped: false, onset: true });
    } else if ((m = RE_FAST.exec(line))) {
      if (!commits.has(m[1])) commits.set(m[1], []);
      commits.get(m[1]).push({ t: secs(ts), pos: +m[2], ms: +m[3] });
    } else if ((m = RE_LAND.exec(line))) {
      if (!lands.has(m[1])) lands.set(m[1], []);
      lands.get(m[1]).push({ t: secs(ts), pos: +m[2] });
    }
  }

  const rows = [];
  for (const f of fires) {
    const landing = (lands.get(f.veh) || []).find((l) => l.t >= f.t && l.t <= f.t + 600);
    if (!landing) continue;
    const c = (commits.get(f.veh) || []).find((c) => c.t >= f.t && c.t <= f.t + 600);
    rows.push({ ...f, landed: landing.pos, err: landing.pos - f.tgt,
                commitMs: c ? c.ms : null,
                commitDrift: landing.pos - f.q,          // queue growth fire→landing (includes our lead consumption)
                effLead: f.tgt - f.q });                  // how early (in positions) we actually were at click
  }
  if (!rows.length) { console.log(`\n${day}: no fires`); continue; }

  // batch structure: fires per 2s bucket
  const buckets = new Map();
  for (const r of rows) { const b = Math.floor(r.t / 2); buckets.set(b, (buckets.get(b) || 0) + 1); }
  const batchSizes = [...buckets.values()].sort((a,b)=>b-a);
  // fires within first 60s of first storm fire (t of first fire with q>40)
  const storm = rows.filter(r => r.q > 40).sort((a,b)=>a.t-b.t);
  let first60 = 0;
  if (storm.length) { const t0 = storm[0].t; first60 = storm.filter(r => r.t <= t0 + 60).length; }

  const errs = rows.map(r=>r.err);
  const inband = rows.filter(r=>Math.abs(r.err)<=10).length;
  const cms = rows.filter(r=>r.commitMs!=null).map(r=>r.commitMs/1000);
  const drifts = rows.map(r=>r.commitDrift);
  const effLeads = rows.map(r=>r.effLead);
  const leads = rows.map(r=>r.lead);
  const predRows = rows.filter(r=>r.pred);
  const clampedRows = rows.filter(r=>r.clamped);
  const over30 = rows.filter(r=>r.err>30).length;
  const under30 = rows.filter(r=>r.err<-30).length;

  console.log(`\n═══ ${day} — ${rows.length} fires ═══`);
  console.log(`  err p50/p90/max/min: ${qtl(errs,.5)}/${qtl(errs,.9)}/${Math.max(...errs)}/${Math.min(...errs)}  ±10: ${(100*inband/rows.length).toFixed(0)}%  >+30: ${over30}  <-30: ${under30}`);
  console.log(`  commit s p50/p90/max: ${qtl(cms,.5)?.toFixed(1)}/${qtl(cms,.9)?.toFixed(1)}/${cms.length?Math.max(...cms).toFixed(1):'-'}  (n=${cms.length})`);
  console.log(`  commitDrift (landed−q@fire) p50/p90/max: ${qtl(drifts,.5)}/${qtl(drifts,.9)}/${Math.max(...drifts)}`);
  console.log(`  effLead (tgt−q@fire) p50/p10: ${qtl(effLeads,.5)}/${qtl(effLeads,.1)}   appliedLead p50/max: ${qtl(leads,.5)}/${Math.max(...leads)}`);
  console.log(`  pred-lead fires: ${predRows.length} (inflight p50 ${qtl(predRows.map(r=>r.inflight),.5)})   flat-clamped fires: ${clampedRows.length}`);
  console.log(`  batch: max fires/2s = ${batchSizes[0]}, top5 = [${batchSizes.slice(0,5)}], fires in first 60s of storm = ${first60}`);
  // error split: pred vs clamped vs rest
  const grp = (rs) => rs.length ? `n=${rs.length} p50=${qtl(rs.map(r=>r.err),.5)} max=${Math.max(...rs.map(r=>r.err))}` : 'n=0';
  console.log(`  err by path — pred: ${grp(predRows)} | clamped(flat≤10): ${grp(clampedRows)} | other: ${grp(rows.filter(r=>!r.pred&&!r.clamped))}`);
  // shallow vs band targets
  const shallow = rows.filter(r=>r.tgt<70), band = rows.filter(r=>r.tgt>=70&&r.tgt<200), deep = rows.filter(r=>r.tgt>=200);
  const bd = (rs)=> rs.length? `n=${rs.length} ±10=${(100*rs.filter(r=>Math.abs(r.err)<=10).length/rs.length).toFixed(0)}% p50=${qtl(rs.map(r=>r.err),.5)}` : 'n=0';
  console.log(`  tgt<70: ${bd(shallow)} | 70-199: ${bd(band)} | ≥200: ${bd(deep)}`);
}
