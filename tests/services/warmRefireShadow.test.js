/**
 * Warm re-fire ladder — SHADOW mode (BOT_WARM_REFIRE=shadow).
 *
 * Shadow must be pure observation: on the exact miss the ladder would recover
 * (click never dispatched, driver absent from V Holding) it LOGS `[Arm] ♻ …
 * SHADOW` and then falls through to the unchanged cold fallback (result null).
 * It must NOT re-dispatch, and it must leave the primary fast path as the
 * original text-search (no hidden-button change) — zero behaviour change.
 *
 * Run: npx jest tests/services/warmRefireShadow.test.js
 */

process.env.BOT_WARM_REFIRE                = 'shadow';
process.env.BOT_ARM_VERIFY_ATTEMPTS        = '3';
process.env.BOT_ARM_VERIFY_PAUSE_MS        = '5';
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS = '3';
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS_MAX = '8';
process.env.BOT_SESSION_PERSIST_PATH       = '/tmp/warm-refire-shadow-test-sessions.json';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

let mockWaiting = new Map();
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

const bot = require('../../src/services/botService');

// A miss session for shadow: probe (call 1) returns whatever `probeResult`
// says; the original text-search dispatch (call 2) returns false → page.click
// throws → the shadow-miss branch. Driver never lands ⇒ cold fallback (null).
function makeShadowMissSession(vehicleNumber, probeResult, counter) {
  return {
    driverId:      820,
    vehicleNumber,
    context:       { close: async () => {} },
    page: {
      isClosed:        () => false,
      evaluate:        async () => {
        counter.n += 1;
        if (counter.n === 1) return probeResult; // read-only shadow probe
        return false;                            // original dispatch: miss
      },
      click:           async () => { throw new Error('page.click: Timeout 2000ms exceeded.'); },
      waitForFunction: async () => { throw new Error('unused'); },
      textContent:     async () => '',
      screenshot:      async () => { throw new Error('no screenshots'); },
      context:         () => ({ storageState: async () => ({}) }),
      on: () => {}, off: () => {},
    },
  };
}

describe('warm re-fire — shadow mode', () => {
  beforeEach(() => bot._resetArmedFireLatencies());

  test('healthy probe VALIDATES the selectors, and the miss logs the shadow line (no re-fire)', async () => {
    mockWaiting = new Map();                        // driver never lands
    const counter = { n: 0 };
    const session = makeShadowMissSession('5150',
      { hadHandler: true, hadHiddenId: true, hadVisibleBtn: true }, counter);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await bot.fireClaimedSession(session);
    const validated = log.mock.calls.some((a) => String(a[0]).includes('SHADOW probe') && String(a[0]).includes('selectors validated'));
    const shadowLine = warn.mock.calls.some((a) => String(a[0]).includes('SHADOW') && String(a[0]).includes('would warm re-fire'));
    warn.mockRestore(); log.mockRestore();

    expect(result).toBeNull();       // cold fallback preserved — NO action taken
    expect(validated).toBe(true);    // selectors confirmed live on the page
    expect(shadowLine).toBe(true);   // and the would-re-fire decision observed
    expect(counter.n).toBe(2);       // probe (read-only) + original dispatch; never re-clicks
  });

  test('a WRONG/renamed element name is caught by the probe with the reason', async () => {
    mockWaiting = new Map();
    const counter = { n: 0 };
    // handler gone + hidden id absent = the "wrong element name" failure.
    const session = makeShadowMissSession('5151',
      { hadHandler: false, hadHiddenId: false, hadVisibleBtn: true }, counter);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await bot.fireClaimedSession(session);
    const missingWarn = warn.mock.calls.some((a) =>
      String(a[0]).includes('HIDDEN BLAZOR ADD PATH MISSING') && String(a[0]).includes('handler=false'));
    warn.mockRestore();

    expect(result).toBeNull();
    expect(missingWarn).toBe(true);  // shadow TELLS us the hidden path is broken, and why
  });
});
