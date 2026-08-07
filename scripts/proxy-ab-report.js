#!/usr/bin/env node
/**
 * Proxy A/B report — run AFTER a storm where BOT_PROXY_AB=1 was live.
 *   node scripts/proxy-ab-report.js logs/2026-08-07.log
 *
 * Joins each fire's [AB] arm tag to its SAN commit-latency line (by vehicle) and
 * compares the PROXY arm (rotating residential IP) vs the ORIGIN control arm.
 * The decisive signal: during a SAN stall (some fires 40s+), do PROXY fires commit
 * FASTER than ORIGIN? If yes → SAN throttles our origin IP → a rotating proxy pool
 * is the fix. If both stall equally → global SAN degradation → a proxy won't help.
 */
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node scripts/proxy-ab-report.js <logfile>'); process.exit(1); }
const lines = fs.readFileSync(path, 'utf8').split('\n');

const arm = {};       // veh -> 'proxy' | 'origin'
const lat = {};       // veh -> commit latency (s)
const land = {};      // veh -> { target, position }
for (const l of lines) {
  let m;
  m = l.match(/\[AB\] #(\S+) arm=(proxy|origin)/);            if (m) { arm[m[1]] = m[2]; continue; }
  m = l.match(/⏱ #(\S+) SAN commit latency ([\d.]+)s/);        if (m) { lat[m[1]] = +m[2]; continue; }
  m = l.match(/📍 Bot queued for #(\S+) — target: (\d+)/);     if (m) { (land[m[1]] ??= {}).target = +m[2]; continue; }
  m = l.match(/#(\S+) landed at (\d+)/);                       if (m) { (land[m[1]] ??= {}).position = +m[2]; continue; }
}

const rows = Object.keys(arm)
  .filter(v => lat[v] != null)
  .map(v => ({ veh: v, arm: arm[v], lat: lat[v],
               err: (land[v]?.position != null && land[v]?.target != null) ? land[v].position - land[v].target : null }));

if (rows.length === 0) { console.log('No [AB]-tagged fires with latency found. Was BOT_PROXY_AB=1 live?'); process.exit(0); }

const stat = a => {
  if (!a.length) return 'n=0';
  const s = [...a].sort((x, y) => x - y);
  const q = p => s[Math.floor(s.length * p)];
  return `n=${a.length}  median=${q(.5).toFixed(1)}s  p90=${q(.9).toFixed(1)}s  max=${s[s.length-1].toFixed(1)}s`;
};
const grp = a => a.reduce((o, r) => ((o[r.arm] ??= []).push(r), o), {});
const g = grp(rows);

console.log(`Proxy A/B report — ${path}\n`);
console.log(`Tagged fires: ${rows.length}  (proxy ${g.proxy?.length||0} / origin ${g.origin?.length||0})\n`);
console.log('COMMIT LATENCY by arm:');
console.log('  PROXY :', stat((g.proxy||[]).map(r => r.lat)));
console.log('  ORIGIN:', stat((g.origin||[]).map(r => r.lat)));

// the decisive slice: only fires during the stall (latency high for SOMEONE)
const stallCut = 40;
const stall = rows.filter(r => r.lat > stallCut);
console.log(`\nDURING SAN STALL (fires with latency > ${stallCut}s), by arm — the decisive comparison:`);
const gs = grp(stall);
if (!stall.length) {
  console.log('  No stall this storm (no fire exceeded 40s). Test inconclusive — need a stall to compare.');
} else {
  console.log('  PROXY :', stat((gs.proxy||[]).map(r => r.lat)), `  (${(gs.proxy||[]).length} of ${g.proxy?.length||0} proxy fires stalled)`);
  console.log('  ORIGIN:', stat((gs.origin||[]).map(r => r.lat)), `  (${(gs.origin||[]).length} of ${g.origin?.length||0} origin fires stalled)`);
  const pRate = (gs.proxy?.length||0) / (g.proxy?.length||1);
  const oRate = (gs.origin?.length||0) / (g.origin?.length||1);
  console.log(`\n  stall RATE: proxy ${(100*pRate).toFixed(0)}%  vs  origin ${(100*oRate).toFixed(0)}%`);
  console.log('  VERDICT:', pRate < oRate * 0.6
    ? '→ PROXY stalls much less → SAN throttles our origin IP → a rotating proxy pool helps. Ship it.'
    : (pRate > oRate * 0.9
      ? '→ both arms stall about equally → global SAN degradation, NOT per-IP throttling → a proxy will NOT help.'
      : '→ partial: proxy helps somewhat. Gather another storm before committing.'));
}

// landing accuracy by arm (secondary — confounded by the proxy hop's own latency)
const ib = a => a.filter(r => r.err != null && Math.abs(r.err) <= 10).length;
console.log('\nLANDING ACCURACY by arm (secondary — proxy hop adds its own baseline latency):');
for (const k of ['proxy', 'origin']) {
  const a = (g[k]||[]).filter(r => r.err != null);
  if (a.length) console.log(`  ${k.padEnd(6)}: ±10=${(100*ib(a)/a.length).toFixed(0)}%  median err=${[...a.map(r=>r.err)].sort((x,y)=>x-y)[a.length>>1]}`);
}
