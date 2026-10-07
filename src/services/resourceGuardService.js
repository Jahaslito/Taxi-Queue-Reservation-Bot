/**
 * Resource guard — keeps the container from running out of process/thread
 * slots (the "Bot temporarily unavailable" / spawn EAGAIN outages).
 * Wired into server.js at boot; self-gates on RESOURCE_GUARD_ENABLED (default on).
 * ─────────────────────────────────────────────────────────────────────────────
 * History: 09-16, 09-29 and 10-06 all failed the same way — every Chromium
 * launch died with `spawn … EAGAIN` / `pthread_create: Resource temporarily
 * unavailable` at the 02:00 arm-pool ramp, ~6 days after the last container
 * restart (09-23→09-29, 09-30→10-06). On 09-30, 5 h after a restart, 140 of the
 * container's 143 processes were ZOMBIES: hardCloseBrowser kill(-pid)s the whole
 * Chromium group, the children get re-parented to PID 1, and PID 1 was
 * pm2-runtime, which never wait()s on them. Each zombie holds a pid slot until
 * the container restarts.
 *
 * The real fix is an init as PID 1 (tini — Dockerfile ENTRYPOINT + compose
 * `init: true`). This service is the backstop so a missed deploy or an unknown
 * future leak can never take the bot down again:
 *   0. ORPHAN SWEEP — at boot and every interval, SIGKILLs LIVE Chromium whose
 *                   owner is gone (node restarted/crashed, leader killed). An
 *                   init only reaps the dead; live orphans keep their threads.
 *   1. BOOT CHECK — logs an ERROR if PID 1 is not an init (reaping disabled).
 *   2. WATCH      — every CHECK_INTERVAL samples zombies / threads / cgroup pids
 *                   usage; logs hourly, WARNs past the warn thresholds.
 *   3. SELF-HEAL  — inside the quiet window (default 00:30–01:30 PT: after the
 *                   00:00 daily reset, before the 02:00 arm ramp, inside the
 *                   11:30 PM–2:30 AM deploy window) restarts the CONTAINER when
 *                   usage is high OR uptime ≥ MAX_UPTIME_DAYS. Restarting only
 *                   the node process would NOT help — zombies belong to PID 1 —
 *                   so we SIGTERM PID 1 and `restart: always` brings it back.
 *
 * Linux-only (/proc + cgroup); on macOS dev it logs once and no-ops.
 */

const fs   = require('fs');
const path = require('path');

const ENABLED      = (process.env.RESOURCE_GUARD_ENABLED      ?? 'true') === 'true';
const AUTO_RESTART = (process.env.RESOURCE_GUARD_AUTO_RESTART ?? 'true') === 'true';

const CHECK_INTERVAL_MS = parseInt(process.env.RESOURCE_GUARD_INTERVAL_MS ?? String(5 * 60 * 1000), 10);

// Warn thresholds (log only).
const WARN_PIDS_PCT = parseFloat(process.env.RESOURCE_GUARD_WARN_PIDS_PCT ?? '0.30');
const WARN_ZOMBIES  = parseInt(process.env.RESOURCE_GUARD_WARN_ZOMBIES   ?? '300', 10);
const WARN_MEM_PCT  = parseFloat(process.env.RESOURCE_GUARD_WARN_MEM_PCT  ?? '0.85');

// Restart thresholds (any one triggers, only inside the window).
const RESTART_PIDS_PCT = parseFloat(process.env.RESOURCE_GUARD_RESTART_PIDS_PCT ?? '0.50');
const RESTART_ZOMBIES  = parseInt(process.env.RESOURCE_GUARD_RESTART_ZOMBIES   ?? '1000', 10);
// Preventive restart: failures hit at ~6 days uptime, so never let it get there
// even if the cause is something the counters above don't see. 0 disables.
const MAX_UPTIME_DAYS  = parseFloat(process.env.RESOURCE_GUARD_MAX_UPTIME_DAYS ?? '3');

// Restart window, PT, "HH:MM" (start inclusive, end exclusive).
const WINDOW_START = process.env.RESOURCE_GUARD_WINDOW_START ?? '00:30';
const WINDOW_END   = process.env.RESOURCE_GUARD_WINDOW_END   ?? '01:30';

const INIT_RE = /(^|\/)(tini|docker-init|dumb-init)(\0|$|\s)/;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** cgroup pids usage — v2 first, then v1. `max` = Infinity when unlimited. */
function readPidsCgroup(cgroupRoot) {
  for (const dir of [cgroupRoot, path.join(cgroupRoot, 'pids')]) {
    const cur = readText(path.join(dir, 'pids.current'));
    const max = readText(path.join(dir, 'pids.max'));
    if (cur != null && max != null) {
      const m = max.trim();
      return { current: parseInt(cur, 10), max: m === 'max' ? Infinity : parseInt(m, 10) };
    }
  }
  return { current: null, max: null };
}

/** cgroup memory usage — v2 first, then v1. */
function readMemCgroup(cgroupRoot) {
  for (const [dir, cur, max] of [
    [cgroupRoot, 'memory.current', 'memory.max'],
    [path.join(cgroupRoot, 'memory'), 'memory.usage_in_bytes', 'memory.limit_in_bytes'],
  ]) {
    const c = readText(path.join(dir, cur));
    const m = readText(path.join(dir, max));
    if (c != null && m != null) {
      const mv = m.trim() === 'max' ? Infinity : parseInt(m, 10);
      return { current: parseInt(c, 10), max: mv > 2 ** 60 ? Infinity : mv };  // v1 "unlimited" is a huge number
    }
  }
  return { current: null, max: null };
}

/** One sample of the container's process table. Returns null off Linux. */
function readSnapshot({ procRoot = '/proc', cgroupRoot = '/sys/fs/cgroup' } = {}) {
  let entries;
  try { entries = fs.readdirSync(procRoot); } catch { return null; }
  let processes = 0, zombies = 0, threads = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const status = readText(path.join(procRoot, name, 'status'));
    if (!status) continue;              // exited between readdir and read
    processes++;
    if (/^State:\s+Z/m.test(status)) zombies++;
    const t = status.match(/^Threads:\s+(\d+)/m);
    threads += t ? parseInt(t[1], 10) : 0;
  }
  if (processes === 0) return null;
  const pid1Cmd = (readText(path.join(procRoot, '1', 'cmdline')) ?? '').replace(/\0+$/, '');
  const pids = readPidsCgroup(cgroupRoot);
  const mem  = readMemCgroup(cgroupRoot);
  return {
    memCurrent: mem.current,
    memMax:     mem.max,
    processes, zombies, threads,
    pidsCurrent: pids.current,
    pidsMax:     pids.max,
    pid1Cmd:     pid1Cmd.replace(/\0/g, ' '),
    pid1IsInit:  INIT_RE.test(pid1Cmd),
  };
}

// ─── Orphan browser sweep ─────────────────────────────────────────────────────
// A LIVE Chromium whose parent is no longer this node process is an orphan: its
// owner died (pm2 restart, crash, SIGKILL) or its leader was killed and the
// children were re-parented to the init. Nothing will ever close it, and it
// keeps all its threads — the leak an init can't fix (it only reaps the DEAD).
// Every browser we own is either a direct child of node (the leader) or a
// descendant of a live Chromium, so the rule is: Chromium process whose parent
// is neither node nor another Chromium ⇒ orphan ⇒ SIGKILL. Zombies (State Z)
// are skipped — they're already dead; the init reaps them.
const CHROME_RE = /chrom(e|ium)/i;

function listProcs(procRoot = '/proc') {
  let entries;
  try { entries = fs.readdirSync(procRoot); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const status = readText(path.join(procRoot, name, 'status'));
    if (!status) continue;
    const ppid  = status.match(/^PPid:\s+(\d+)/m);
    const state = status.match(/^State:\s+(\S)/m);
    const argv0 = (readText(path.join(procRoot, name, 'cmdline')) ?? '').split('\0')[0];
    out.push({ pid: +name, ppid: ppid ? +ppid[1] : 0, state: state ? state[1] : '?', argv0 });
  }
  return out;
}

/** Pure — exported for tests. */
function findOrphanBrowsers(procs, selfPid) {
  const isChrome = new Set(procs.filter((p) => CHROME_RE.test(p.argv0)).map((p) => p.pid));
  return procs.filter((p) =>
    isChrome.has(p.pid) && p.state !== 'Z' && p.ppid !== selfPid && !isChrome.has(p.ppid));
}

function sweepOrphanBrowsers(reason, procRoot = '/proc') {
  const orphans = findOrphanBrowsers(listProcs(procRoot), process.pid);
  let killed = 0;
  for (const o of orphans) {
    // Kill the orphan's whole group too: its own children are Chromium (so not
    // orphans themselves) and would otherwise become the next sweep's orphans.
    try { process.kill(-o.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(o.pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  if (killed > 0) console.warn(`[ResourceGuard] killed ${killed} orphaned Chromium process(es) (${reason})`);
  return killed;
}

function pidsPct(s) {
  return s.pidsCurrent != null && Number.isFinite(s.pidsMax) && s.pidsMax > 0
    ? s.pidsCurrent / s.pidsMax : 0;
}

/** Minutes since midnight in PT. */
function ptMinutes(date) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).split(':').map(Number);
  return (h % 24) * 60 + m;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function inWindow(date, start = WINDOW_START, end = WINDOW_END) {
  const now = ptMinutes(date), s = toMinutes(start), e = toMinutes(end);
  return s <= e ? (now >= s && now < e) : (now >= s || now < e);   // supports wrap past midnight
}

/**
 * Pure decision — returns the restart reason, or null. Exported for tests.
 */
function restartReason(s, { uptimeSec, now }, cfg = {}) {
  const {
    pidsPctLimit = RESTART_PIDS_PCT, zombieLimit = RESTART_ZOMBIES,
    maxUptimeDays = MAX_UPTIME_DAYS, windowStart = WINDOW_START, windowEnd = WINDOW_END,
  } = cfg;
  if (!s || !inWindow(now, windowStart, windowEnd)) return null;
  const pct = pidsPct(s);
  if (pct >= pidsPctLimit)    return `pids ${s.pidsCurrent}/${s.pidsMax} (${(pct * 100).toFixed(0)}%) ≥ ${(pidsPctLimit * 100).toFixed(0)}%`;
  if (s.zombies >= zombieLimit) return `zombies ${s.zombies} ≥ ${zombieLimit}`;
  if (maxUptimeDays > 0 && uptimeSec >= maxUptimeDays * 86400) {
    return `uptime ${(uptimeSec / 86400).toFixed(1)}d ≥ ${maxUptimeDays}d (preventive)`;
  }
  return null;
}

function memPct(s) {
  return s.memCurrent != null && Number.isFinite(s.memMax) && s.memMax > 0 ? s.memCurrent / s.memMax : 0;
}

function fmt(s) {
  const lim = Number.isFinite(s.pidsMax) ? s.pidsMax : 'unlimited';
  const gb  = (b) => (b / 2 ** 30).toFixed(1);
  const mem = s.memCurrent != null
    ? ` mem=${gb(s.memCurrent)}/${Number.isFinite(s.memMax) ? gb(s.memMax) : '∞'}GB`
    : '';
  return `processes=${s.processes} zombies=${s.zombies} threads=${s.threads} pids=${s.pidsCurrent ?? '?'}/${lim}${mem}`;
}

/** Container uptime (PID 1 age) in seconds; falls back to this process. */
function containerUptimeSec(procRoot = '/proc') {
  try {
    const uptime = parseFloat(readText(path.join(procRoot, 'uptime')).split(' ')[0]);
    const stat   = readText(path.join(procRoot, '1', 'stat'));
    const start  = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], 10);  // field 22
    const hz     = 100;  // USER_HZ — 100 on every Linux we deploy to
    const age    = uptime - start / hz;
    if (Number.isFinite(age) && age >= 0) return age;
  } catch { /* fall through */ }
  return process.uptime();
}

let timer = null;
let lastHourlyLog = 0;

function check() {
  sweepOrphanBrowsers('periodic');
  const s = readSnapshot();
  if (!s) return;
  const pct = pidsPct(s);
  const now = Date.now();
  // Memory: an OOM-killed Chromium surfaces as "Target … browser has been
  // closed", which sanitizes to the SAME "Bot temporarily unavailable" message.
  if (pct >= WARN_PIDS_PCT || s.zombies >= WARN_ZOMBIES || memPct(s) >= WARN_MEM_PCT) {
    console.warn(`[ResourceGuard] ⚠ high process usage — ${fmt(s)}`);
  } else if (now - lastHourlyLog >= 60 * 60 * 1000) {
    lastHourlyLog = now;
    console.log(`[ResourceGuard] ${fmt(s)}`);
  }

  const reason = restartReason(s, { uptimeSec: containerUptimeSec(), now: new Date() });
  if (!reason) return;
  // Loop guard: if a previous attempt only restarted node (PID 1 signal failed),
  // don't keep bouncing it every interval for the rest of the window.
  if (process.uptime() < 30 * 60) return;
  if (!AUTO_RESTART) {
    console.warn(`[ResourceGuard] would restart container (${reason}) — RESOURCE_GUARD_AUTO_RESTART=false`);
    return;
  }
  console.warn(`[ResourceGuard] ↻ restarting container to free process slots — ${reason} — ${fmt(s)}`);
  // Give the logger a moment to flush, then stop PID 1. Docker's `restart: always`
  // brings the container straight back with a clean process table.
  setTimeout(() => {
    try { process.kill(1, 'SIGTERM'); }
    catch (err) {
      console.error(`[ResourceGuard] could not signal PID 1 (${err.message}) — exiting node instead`);
      process.exit(1);
    }
  }, 2000);
  stop();
}

function start() {
  if (!ENABLED) {
    console.log('[ResourceGuard] disabled (RESOURCE_GUARD_ENABLED=false)');
    return;
  }
  const s = readSnapshot();
  if (!s) {
    console.log('[ResourceGuard] /proc not available (non-Linux) — guard inactive');
    return;
  }
  // Browsers left running by a previous node instance (pm2 restart / crash)
  // still hold their threads — clear them before the arm ramp needs the slots.
  sweepOrphanBrowsers('boot');
  if (!s.pid1IsInit) {
    console.error(
      `[ResourceGuard] ⛔ PID 1 is "${s.pid1Cmd}", not an init — zombie Chromium processes will NOT be reaped ` +
      'and browser launches will fail with EAGAIN after a few days. Rebuild the image (tini ENTRYPOINT) / set `init: true`.',
    );
  }
  console.log(
    `[ResourceGuard] started — ${fmt(s)}; pid1=${s.pid1IsInit ? 'init ✓' : 'NOT init ✗'}; ` +
    `auto-restart=${AUTO_RESTART ? `on (${WINDOW_START}–${WINDOW_END} PT, pids≥${RESTART_PIDS_PCT * 100}% | zombies≥${RESTART_ZOMBIES} | uptime≥${MAX_UPTIME_DAYS}d)` : 'off'}`,
  );
  lastHourlyLog = Date.now();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, readSnapshot, restartReason, inWindow, pidsPct, findOrphanBrowsers, sweepOrphanBrowsers };
