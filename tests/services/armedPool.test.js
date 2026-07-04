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
