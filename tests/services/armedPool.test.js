/**
 * Pre-armed fire sessions — BROWSER POOL tests (mocked Playwright).
 *
 * The pool refactor (BOT_ARMED_BROWSERS) is what spreads same-tick fire
 * clicks across Chromium processes. These tests pin its safety properties:
 *   1. contexts spread across the pool (including arms IN FLIGHT — a
 *      concurrent batch must not clump onto one browser);
 *   2. one browser dying drops ONLY its own sessions (the rest keep their
 *      armed pages — no fleet-wide disarm like the single-browser era);
 *   3. when nothing is armed, every pool browser is closed (memory back to
 *      baseline, same idle contract as before the pool).
 *
 * Run: npx jest tests/services/armedPool.test.js
 */

process.env.BOT_ARMED_BROWSERS      = '3';
process.env.BOT_ARMED_MAX           = '40';
process.env.BOT_ARM_OPS_CONCURRENCY = '4';
process.env.BOT_SESSION_PERSIST_PATH = '/tmp/armed-pool-test-sessions.json';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));
const { chromium } = require('playwright');

const launched = []; // every fake browser, in launch order (slot order)

function makePage() {
  return {
    goto:            async () => {},
    waitForURL:      async () => {},
    url:             () => 'https://san.gtcvms.com/gsidispatch.edispatch/requestTrip',
    waitForFunction: async () => {},
    fill:            async () => {},
    click:           async () => {},
    evaluate:        async () => false,   // isWaitScreen → not on WAIT screen
    textContent:     async () => '',      // no "Vehicle Not Available"
    isVisible:       async () => true,    // Add To Queue button present → 'armed'
    route:           async () => {},
    context:         () => ({ storageState: async () => ({}) }),
  };
}

function makeBrowser() {
  const b = {
    _handlers:  {},
    _connected: true,
    on:          (ev, fn) => { b._handlers[ev] = fn; },
    isConnected: () => b._connected,
    close:       jest.fn(async () => { b._connected = false; }),
    newContext:  jest.fn(async () => ({
      storageState: async () => ({}),
      close:        jest.fn(async () => {}),
      newPage:      async () => makePage(),
    })),
    // Simulate a crash: Playwright fires 'disconnected' after the process dies.
    _crash: () => { b._connected = false; b._handlers.disconnected?.(); },
  };
  launched.push(b);
  return b;
}

chromium.launch.mockImplementation(async () => makeBrowser());

const bot = require('../../src/services/botService');

const wanted = (n) => Array.from({ length: n }, (_, i) => ({
  driverId:         100 + i,
  vehicleNumber:    `V${i}`,
  secondsUntilFire: 60 + i,
  getCredentials:   async () => ({ sanUsername: `probe-u${i}`, sanPassword: 'p' }),
}));

describe('armed browser pool', () => {
  test('5 concurrent arms spread across all 3 pool browsers (in-flight aware)', async () => {
    await bot.syncFireSessions(wanted(5));
    const stats = bot.armedFireSessionStats();
    expect(stats.armed).toBe(5);
    expect(stats.browsers).toBe(3);              // all 3 slots launched…
    expect(chromium.launch).toHaveBeenCalledTimes(3);
    const perSlot = [0, 0, 0];
    for (const s of stats.sessions) perSlot[s.browserSlot]++;
    expect([...perSlot].sort().join(',')).toBe('1,2,2'); // …and balanced, not clumped
  });

  test('one browser dying drops only ITS sessions; the rest stay armed', async () => {
    const before = bot.armedFireSessionStats();
    const deadSlot = before.sessions[0].browserSlot;
    const onDead   = before.sessions.filter((s) => s.browserSlot === deadSlot).length;

    launched[deadSlot]._crash();

    const after = bot.armedFireSessionStats();
    expect(after.armed).toBe(before.armed - onDead);           // victims dropped…
    expect(after.sessions.every((s) => s.browserSlot !== deadSlot)).toBe(true);
    expect(after.armed).toBeGreaterThan(0);                    // …survivors intact
  });

  test('empty wanted set disarms everything and closes every pool browser', async () => {
    await bot.syncFireSessions([]);
    const stats = bot.armedFireSessionStats();
    expect(stats.armed).toBe(0);
    expect(stats.browsers).toBe(0);
    expect(stats.browser).toBe(false);
    for (const b of launched) {
      // every browser is gone — closed by us, or already dead from the crash test
      expect(b.isConnected()).toBe(false);
    }
  });
});

// An arm op can spend seconds queued on the arm-ops semaphore or mid-login
// while its driver fires anyway (usually cold) and drops out of the wanted
// set. Without a re-check the op finishes a full SAN login and parks an
// orphan session mid-storm (07-27: several of the 35 fire-minute logins were
// for drivers whose fire was already in flight). These pin both re-check
// points: after semaphore acquisition, and before parking the session.
describe('arm-op wanted-set re-check', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  test('op queued on the semaphore aborts once its driver leaves the wanted set', async () => {
    // 5 wanted, concurrency 4: the first 4 hold the semaphore (stalled in
    // getCredentials), the 5th queues behind them.
    const gates = Array.from({ length: 5 }, () => deferred());
    const ws = gates.map((g, i) => ({
      driverId:         200 + i,
      vehicleNumber:    `Q${i}`,
      secondsUntilFire: 10 + i,            // ranked order = index order
      getCredentials:   () => g.promise,
    }));
    const p1 = bot.syncFireSessions(ws);
    // Next tick: the 5th driver fired meanwhile — no longer wanted.
    await bot.syncFireSessions(ws.slice(0, 4));
    gates.forEach((g, i) => g.resolve({ sanUsername: `q-u${i}`, sanPassword: 'p' }));
    await p1;

    const stats = bot.armedFireSessionStats();
    expect(stats.armed).toBe(4);
    expect(stats.sessions.some((s) => s.driverId === 204)).toBe(false);
  });

  test('a login finishing after the driver stops being wanted is released, not parked', async () => {
    const gate = deferred();
    const late = {
      driverId:         300,
      vehicleNumber:    'LATE',
      secondsUntilFire: 5,
      getCredentials:   () => gate.promise,
    };
    // Passes the queued-op re-check (still wanted), then stalls pre-login.
    const p = bot.syncFireSessions([late]);
    // Next tick: fired meanwhile — wanted set no longer includes them.
    await bot.syncFireSessions([]);
    gate.resolve({ sanUsername: 'late-u', sanPassword: 'p' });
    await p;

    // Without the pre-park re-check this would be 1 — an orphan armed session.
    expect(bot.armedFireSessionStats().armed).toBe(0);
  });
});
