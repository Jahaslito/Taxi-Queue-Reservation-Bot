const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { readSnapshot, restartReason, inWindow, findOrphanBrowsers } = require('../../src/services/resourceGuardService');

// 2026-10-06 is PDT (UTC−7): 00:45 PT = 07:45Z, 03:00 PT = 10:00Z.
const IN_WINDOW  = new Date('2026-10-06T07:45:00Z');
const OUT_WINDOW = new Date('2026-10-06T10:00:00Z');

function fakeProc({ pid1 = 'pm2-runtime\0start\0ecosystem.config.js\0', procs, pidsMax = '19144', pidsCurrent = '164' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  const proc = path.join(root, 'proc');
  const cg   = path.join(root, 'cg');
  fs.mkdirSync(cg);
  fs.writeFileSync(path.join(cg, 'pids.max'), `${pidsMax}\n`);
  fs.writeFileSync(path.join(cg, 'pids.current'), `${pidsCurrent}\n`);
  procs.forEach(([pid, state, threads]) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\tx\nState:\t${state}\nThreads:\t${threads}\n`);
  });
  fs.writeFileSync(path.join(proc, '1', 'cmdline'), pid1);
  fs.mkdirSync(path.join(proc, 'self'));   // non-numeric entries are ignored
  return { procRoot: proc, cgroupRoot: cg };
}

const snap = (o = {}) => ({ processes: 10, zombies: 0, threads: 50, pidsCurrent: 100, pidsMax: 19144, ...o });

describe('readSnapshot', () => {
  test('counts zombies, threads and cgroup pids; flags non-init PID 1', () => {
    const s = readSnapshot(fakeProc({
      procs: [[1, 'S (sleeping)', 11], [20, 'Z (zombie)', 1], [21, 'Z (zombie)', 1], [30, 'S (sleeping)', 40]],
    }));
    expect(s).toMatchObject({ processes: 4, zombies: 2, threads: 53, pidsCurrent: 164, pidsMax: 19144, pid1IsInit: false });
  });

  test('recognises tini / docker-init as PID 1 and unlimited pids.max', () => {
    expect(readSnapshot(fakeProc({ pid1: '/usr/bin/tini\0-s\0--\0', procs: [[1, 'S', 1]], pidsMax: 'max' })))
      .toMatchObject({ pid1IsInit: true, pidsMax: Infinity });
    expect(readSnapshot(fakeProc({ pid1: '/sbin/docker-init\0--\0', procs: [[1, 'S', 1]] })).pid1IsInit).toBe(true);
  });

  test('returns null when /proc is missing (macOS dev)', () => {
    expect(readSnapshot({ procRoot: '/definitely/not/here' })).toBeNull();
  });
});

describe('inWindow', () => {
  test('00:30–01:30 PT', () => {
    expect(inWindow(IN_WINDOW)).toBe(true);
    expect(inWindow(OUT_WINDOW)).toBe(false);
  });
  test('supports windows that wrap past midnight', () => {
    expect(inWindow(IN_WINDOW, '23:30', '01:00')).toBe(true);
    expect(inWindow(OUT_WINDOW, '23:30', '01:00')).toBe(false);
  });
});

describe('restartReason', () => {
  const fresh = { uptimeSec: 3600, now: IN_WINDOW };

  test('healthy and young → no restart', () => {
    expect(restartReason(snap(), fresh)).toBeNull();
  });

  test('pids usage ≥ 50% → restart', () => {
    expect(restartReason(snap({ pidsCurrent: 9600 }), fresh)).toMatch(/pids 9600\/19144/);
  });

  test('zombie pile-up → restart', () => {
    expect(restartReason(snap({ zombies: 1500 }), fresh)).toMatch(/zombies 1500/);
  });

  test('preventive restart after 3 days uptime even when counters look fine', () => {
    expect(restartReason(snap(), { uptimeSec: 3.2 * 86400, now: IN_WINDOW })).toMatch(/preventive/);
  });

  test('NEVER restarts outside the quiet window (storm / arm ramp)', () => {
    expect(restartReason(snap({ zombies: 5000, pidsCurrent: 19000 }), { uptimeSec: 9 * 86400, now: OUT_WINDOW })).toBeNull();
  });

  test('unlimited pids.max does not divide by infinity into a false trigger', () => {
    expect(restartReason(snap({ pidsMax: Infinity, pidsCurrent: 50000 }), fresh)).toBeNull();
  });
});

describe('findOrphanBrowsers', () => {
  const NODE = 50;
  const CH   = '/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell';
  const procs = [
    { pid: 1,   ppid: 0,    state: 'S', argv0: '/usr/bin/tini' },
    { pid: 40,  ppid: 1,    state: 'S', argv0: 'node /usr/local/bin/pm2-runtime' },
    { pid: NODE, ppid: 40,  state: 'S', argv0: 'node' },
    // ours: leader is node's child, its children hang off the leader
    { pid: 100, ppid: NODE, state: 'S', argv0: CH },
    { pid: 101, ppid: 100,  state: 'S', argv0: CH },
    { pid: 102, ppid: 100,  state: 'S', argv0: '/ms-playwright/.../chrome_crashpad_handler' },
    // left behind by a dead node instance → re-parented to the init
    { pid: 200, ppid: 1,    state: 'S', argv0: CH },
    { pid: 201, ppid: 200,  state: 'S', argv0: CH },
    // child stranded after its leader was killed
    { pid: 300, ppid: 1,    state: 'S', argv0: '/ms-playwright/.../chrome_crashpad_handler' },
    // already dead — the init reaps it, never signal it
    { pid: 400, ppid: 1,    state: 'Z', argv0: '' },
    { pid: 401, ppid: 1,    state: 'Z', argv0: CH },
    // non-browser process re-parented to the init — not ours to touch
    { pid: 500, ppid: 1,    state: 'S', argv0: '/bin/sh' },
  ];

  test('flags only live Chromium whose owner is gone', () => {
    expect(findOrphanBrowsers(procs, NODE).map((p) => p.pid).sort()).toEqual([200, 300]);
  });

  test('never flags our own browser tree', () => {
    const ours = findOrphanBrowsers(procs, NODE).map((p) => p.pid);
    [100, 101, 102].forEach((pid) => expect(ours).not.toContain(pid));
  });
});
