/**
 * Adaptive fire timeout + verify-on-timeout recovery + roster-scaled pool.
 *
 * Pins the 2026-07-06 storm fixes:
 *   1. adaptiveFireTimeoutMs — 2 × rolling p95 of armed-fire durations,
 *      clamped [BOT_ARM_FIRE_TIMEOUT_MS, BOT_ARM_FIRE_TIMEOUT_MAX_MS], with a
 *      15-min freshness window (yesterday's storm must not inflate today).
 *   2. fireClaimedSession timeout → verify against V Holding BEFORE the cold
 *      fallback: a slow confirmation is a COMMITTED add (Blazor commits on
 *      click processing), so the recovered result must be a genuine landing —
 *      not the "already in queue" wall of 07-06. Absent vehicle still falls
 *      back cold (null) exactly as before.
 *   3. desiredArmedSlots — pool grows one browser per
 *      BOT_ARMED_SESSIONS_PER_BROWSER sessions between the floor and max, so
 *      same-tick click batches stop serialising 4-deep per browser.
 *
 * Run: npx jest tests/services/armedFireRecovery.test.js
 */

process.env.BOT_ARMED_BROWSERS             = '3';
process.env.BOT_ARMED_BROWSERS_MAX         = '8';
process.env.BOT_ARMED_SESSIONS_PER_BROWSER = '6';
process.env.BOT_ARM_FIRE_TIMEOUT_MS        = '12000';
process.env.BOT_ARM_FIRE_TIMEOUT_MAX_MS    = '45000';
process.env.BOT_ARM_VERIFY_ATTEMPTS        = '3';
process.env.BOT_ARM_VERIFY_PAUSE_MS        = '5';
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS = '3'; // keep the fast-release confirm window small in tests
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS_MAX = '8'; // small cap so the clamp is exercised
process.env.BOT_ARM_OPS_CONCURRENCY        = '4';
process.env.BOT_SESSION_PERSIST_PATH       = '/tmp/armed-recovery-test-sessions.json';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));
const { chromium } = require('playwright');

// verifyDriverInQueue lazily requires undici + monitorService's parser — mock
// both so the tests control the V Holding read without network or DB.
let mockWaiting = new Map(); // normalized vehicle → position
jest.mock('undici', () => ({
  fetch: jest.fn(async () => ({ ok: true, text: async () => '<html>' })),
}));
jest.mock('../../src/services/monitorService', () => ({
  _parseQueue: () => ({
    waiting:        mockWaiting,
    dispatched:     new Map(),
    dispatchedDest: new Map(),
    notAuthorized:  new Set(),
  }),
  _norm: (v) => String(v).trim().toUpperCase(),
}));
const { fetch: mockFetch } = require('undici');

const launched = [];
function makePage() {
  return {
    goto:            async () => {},
    waitForURL:      async () => {},
    url:             () => 'https://san.gtcvms.com/gsidispatch.edispatch/requestTrip',
    waitForFunction: async () => {},
    fill:            async () => {},
    click:           async () => {},
    evaluate:        async () => false,
    textContent:     async () => '',
    isVisible:       async () => true,
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
  };
  launched.push(b);
  return b;
}
chromium.launch.mockImplementation(async () => makeBrowser());

const bot = require('../../src/services/botService');

/** Claimed-session stand-in whose confirmation wait always times out. */
function makeTimedOutSession(vehicleNumber) {
  return {
    driverId:      700,
    vehicleNumber,
    context:       { close: async () => {} },
    page: {
      evaluate:        async () => true, // fast-path click dispatched in-page
      click:           async () => {},
      waitForFunction: async () => { throw new Error('page.waitForFunction: Timeout 12000ms exceeded.'); },
      textContent:     async () => '',
      screenshot:      async () => { throw new Error('no screenshots in tests'); },
      context:         () => ({ storageState: async () => ({}) }),
      on:  () => {},
      off: () => {},
    },
  };
}

describe('adaptive fire timeout', () => {
  // Far-future base so latencies recorded by other tests are pruned away.
  const base = Date.now() + 3600_000;

  test('no samples → floor', () => {
    expect(bot._adaptiveFireTimeoutMs(base)).toBe(12000);
  });

  test('calm-day samples stay on the floor', () => {
    for (const ms of [3000, 3500, 4200, 5000]) bot._recordArmedFireDuration(ms, base);
    expect(bot._adaptiveFireTimeoutMs(base)).toBe(12000); // 2 × p95 = 10 s < floor
  });

  test('storm escalation raises the ceiling to 2 × p95', () => {
    for (const ms of [9000, 9700, 9800, 9800]) bot._recordArmedFireDuration(ms, base + 1000);
    // p95 of [3000,3500,4200,5000,9000,9700,9800,9800] = 9800
    expect(bot._adaptiveFireTimeoutMs(base + 1000)).toBe(19600);
  });

  test('clamped at the max', () => {
    bot._recordArmedFireDuration(40000, base + 2000);
    expect(bot._adaptiveFireTimeoutMs(base + 2000)).toBe(45000);
  });

  test('stale samples pruned → back to the floor', () => {
    expect(bot._adaptiveFireTimeoutMs(base + 2000 + 16 * 60_000)).toBe(12000);
  });
});

describe('fast-release verify window adapts to commit latency', () => {
  // Fresh far-future base so the other describe's samples are pruned (15 min window).
  const base = Date.now() + 7200_000;

  // This suite: BOT_FIRE_RELEASE_VERIFY_ATTEMPTS=3 (floor), cap=8; ARM_FIRE_TIMEOUT_MS=12000.
  test('calm day → the configured floor (unchanged behaviour)', () => {
    // no fresh samples → adaptive window at the 12 s floor → ratio 1 → base attempts (3)
    expect(bot._fireReleaseVerifyAttempts(base)).toBe(3);
  });

  test('high-latency storm → attempts scale up with commit latency', () => {
    // p95 = 12 s → adaptive window = 2×12 s = 24 s = 2× the 12 s floor → 2× base = 6
    for (const ms of [12000, 12000, 12000, 12000, 12000]) bot._recordArmedFireDuration(ms, base + 1000);
    expect(bot._fireReleaseVerifyAttempts(base + 1000)).toBe(6);
    // production semantics: at the real 12-attempt floor this is a ~24-attempt / ~36 s
    // window — enough to catch the 08-05 fires that committed at ~19 s (fixed ~18 s window false-failed).
  });

  test('clamped at the absolute max attempts', () => {
    // 2×40 s clamps adaptive to the 45 s max → ratio 3.75 → 3×3.75≈11, clamped to the cap (8)
    bot._recordArmedFireDuration(40000, base + 2000);
    expect(bot._fireReleaseVerifyAttempts(base + 2000)).toBe(8);
  });
});

describe('proxy A/B arm (BOT_PROXY_AB)', () => {
  const load = (env) => {
    let mod;
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    jest.isolateModules(() => { mod = require('../../src/services/botService'); });
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    return mod;
  };

  test('A/B off → null (no split, unchanged behaviour)', () => {
    expect(load({ BOT_PROXY_AB: '0' })._proxyAbArm('0582')).toBeNull();
  });

  test('A/B on → deterministic per-vehicle arm', () => {
    const m = load({ BOT_PROXY_AB: '1', BOT_PROXY_AB_ORIGIN_PCT: '30' });
    const a = m._proxyAbArm('0582');
    expect(['proxy', 'origin']).toContain(a);
    expect(m._proxyAbArm('0582')).toBe(a); // stable
  });

  test('origin share roughly matches BOT_PROXY_AB_ORIGIN_PCT', () => {
    const m = load({ BOT_PROXY_AB: '1', BOT_PROXY_AB_ORIGIN_PCT: '30' });
    let origin = 0; const N = 500;
    for (let v = 0; v < N; v++) if (m._proxyAbArm(String(1000 + v)) === 'origin') origin++;
    const pct = 100 * origin / N;
    expect(pct).toBeGreaterThan(20);
    expect(pct).toBeLessThan(40);
  });

  test('fireProxyConfig: proxy is scoped to the morning-rush window', () => {
    const m = load({ BOT_PROXY_AB: '1', PROXY_ACTIVE_FROM_PT: '03:00', PROXY_ACTIVE_TO_PT: '08:00' });
    const inRush = new Date('2026-08-07T04:30:00-07:00');
    const midday = new Date('2026-08-07T12:00:00-07:00');
    expect(m._withinProxyWindow(inRush)).toBe(true);
    expect(m._withinProxyWindow(midday)).toBe(false);
    // outside the window: no proxy, no A/B tag, regardless of vehicle
    expect(m._fireProxyConfig('4016', midday)).toEqual({ proxyConfig: null, abArm: null });
    // inside the window: A/B arm is assigned (proxyConfig is null here only because
    // PROXY_SERVER is unset in tests — the gate we assert is the arm/window scope)
    expect(['proxy', 'origin']).toContain(m._fireProxyConfig('4016', inRush).abArm);
  });
});

describe('verify-on-timeout recovery', () => {
  // Isolate from latency samples recorded by the adaptive-window suites above, so
  // the fast-release confirm window sits at its floor (deterministic fetch count).
  beforeEach(() => bot._resetArmedFireLatencies());

  test('timeout + vehicle present in V Holding → recovered genuine landing', async () => {
    mockWaiting = new Map([['9999', 57]]);
    mockFetch.mockClear();

    const result = await bot.fireClaimedSession(makeTimedOutSession('9999'));

    expect(result).not.toBeNull();
    expect(result.success).toBe(true);
    expect(result.recoveredFromTimeout).toBe(true); // same flag as the cold-path recovery
    expect(result.viaArmedSession).toBe(true);
    expect(result.alreadyQueued).toBe(false);      // genuine landing, not the 07-06 wall
    expect(result.position).toBe(57);
    expect(result.location).toBe('V Holding');
    expect(mockFetch).toHaveBeenCalledTimes(1);    // found on the first read
  });

  test('timeout + vehicle absent → null (cold fallback preserved)', async () => {
    mockWaiting = new Map();
    mockFetch.mockClear();

    const result = await bot.fireClaimedSession(makeTimedOutSession('4444'));

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);    // every verify attempt exhausted
  });
});

// 2026-07-21 pipeline-declog: when the WAIT screen doesn't render within
// FIRE_RELEASE_MS (the storm case that jams the pool), the fire path must
// RELEASE the browser BEFORE confirming, then confirm the committed add via the
// authoritative V Holding read. Frees the browser for the fires behind it.
describe('fast page release under load', () => {
  test('WAIT screen slow → page disposed BEFORE the V Holding confirm, genuine landing returned', async () => {
    mockWaiting = new Map([['7777', 91]]);
    mockFetch.mockClear();

    const events = [];
    // WAIT screen never renders in the release window; record dispose ordering.
    const session = {
      driverId:      701,
      vehicleNumber: '7777',
      context:       { close: async () => { events.push('context-closed'); } },
      page: {
        evaluate:        async () => true,             // click dispatched in-page
        click:           async () => {},
        waitForFunction: async () => { throw new Error('page.waitForFunction: Timeout 3000ms exceeded.'); },
        textContent:     async () => '',
        screenshot:      async () => { throw new Error('no screenshots'); },
        context:         () => ({ storageState: async () => ({}) }),
        on: () => {}, off: () => {},
      },
    };
    // Record when the V Holding read happens relative to the dispose.
    mockFetch.mockImplementation(async () => { events.push('vholding-read'); return { ok: true, text: async () => '<html>' }; });

    const result = await bot.fireClaimedSession(session);

    expect(result).not.toBeNull();
    expect(result.success).toBe(true);
    expect(result.position).toBe(91);
    expect(result.recoveredFromTimeout).toBe(true);
    expect(result.alreadyQueued).toBe(false);
    // The browser is freed BEFORE we spend time reading V Holding — that's the
    // whole point: the pipeline declogs for the next fires.
    expect(events[0]).toBe('context-closed');
    expect(events).toContain('vholding-read');
    expect(events.indexOf('context-closed')).toBeLessThan(events.indexOf('vholding-read'));

    mockFetch.mockImplementation(async () => ({ ok: true, text: async () => '<html>' }));
  });
});

describe('roster-scaled armed pool', () => {
  test('desiredArmedSlots: floor, scaling, cap', () => {
    expect(bot._desiredArmedSlots(1)).toBe(3);     // floor (BOT_ARMED_BROWSERS)
    expect(bot._desiredArmedSlots(18)).toBe(3);    // 18/6 = exactly the floor
    expect(bot._desiredArmedSlots(19)).toBe(4);    // first growth step
    expect(bot._desiredArmedSlots(36)).toBe(6);    // 07-06 roster size
    expect(bot._desiredArmedSlots(1000)).toBe(8);  // BOT_ARMED_BROWSERS_MAX cap
  });

  test('36 armed sessions open 6 browsers, none over-packed', async () => {
    const wanted = Array.from({ length: 36 }, (_, i) => ({
      driverId:         100 + i,
      vehicleNumber:    `V${i}`,
      secondsUntilFire: 60 + i,
      getCredentials:   async () => ({ sanUsername: `u${i}`, sanPassword: 'p' }),
    }));
    await bot.syncFireSessions(wanted);

    const stats = bot.armedFireSessionStats();
    expect(stats.armed).toBe(36);
    expect(stats.browsers).toBe(6);                // ceil(36/6), not the old 3
    const perSlot = {};
    for (const s of stats.sessions) perSlot[s.browserSlot] = (perSlot[s.browserSlot] ?? 0) + 1;
    expect(Object.keys(perSlot).length).toBe(6);
    for (const n of Object.values(perSlot)) expect(n).toBeLessThanOrEqual(8);

    await bot.syncFireSessions([]);                // cleanup: close the pool
    expect(bot.armedFireSessionStats().browsers).toBe(0);
  });
});
