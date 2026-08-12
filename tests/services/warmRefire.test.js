/**
 * Warm re-fire ladder (BOT_WARM_REFIRE) — the 2026-08-11 big-overshoot fix.
 *
 * When an armed click never dispatches (the CPU-starved renderer can't ready
 * the Add button under a same-tick fire batch, so page.click blows its 2 s
 * actionability timeout), the driver used to drop to the cold path and land
 * 48–63 s / +160 late. With the flag on, fireClaimedSession re-dispatches WARM
 * on the still-open circuit instead of conceding to cold.
 *
 * Pins:
 *   1. dispatch-miss + driver absent → warm re-fire, on a later attempt the
 *      dispatch succeeds and the add is confirmed via V Holding (genuine
 *      landing, viaArmedSession, warmRefired). No cold fallback (non-null).
 *   2. the re-fire frees the browser BEFORE the patient V Holding confirm
 *      (pool must not jam), and never re-clicks a committed add (double-add).
 *   3. a real confirm-timeout (the click DID dispatch) does NOT warm re-fire —
 *      the add is in flight; that path is left to the existing recovery.
 *
 * Run: npx jest tests/services/warmRefire.test.js
 */

process.env.BOT_WARM_REFIRE                = '1';
process.env.BOT_WARM_REFIRE_ATTEMPTS       = '3';
process.env.BOT_WARM_REFIRE_MS             = '2500';
process.env.BOT_ARM_VERIFY_ATTEMPTS        = '3';
process.env.BOT_ARM_VERIFY_PAUSE_MS        = '5';
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS = '3';
process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS_MAX = '8';
process.env.BOT_SESSION_PERSIST_PATH       = '/tmp/warm-refire-test-sessions.json';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

// verifyDriverInQueue lazily requires undici + monitorService's parser — mock
// both so the tests drive the V Holding read without network or DB.
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

const bot = require('../../src/services/botService');

describe('warm re-fire ladder (BOT_WARM_REFIRE)', () => {
  beforeEach(() => bot._resetArmedFireLatencies());

  test('dispatch miss + driver absent → warm re-fire, later attempt lands (no cold fallback)', async () => {
    // Driver shows up in V Holding only AFTER the re-dispatch commits.
    mockWaiting = new Map();

    // First in-page dispatch fails (button not ready); the initial page.click
    // throws its actionability timeout (nothing dispatched → dispatchedAtMs null).
    // The warm re-fire's 2nd dispatch succeeds, and the add then appears.
    let evalCalls = 0;
    const disposeOrder = [];
    const session = {
      driverId:      810,
      vehicleNumber: '5150',
      context:       { close: async () => { disposeOrder.push('context-closed'); } },
      page: {
        isClosed:        () => false,
        // dispatchAddInPage's page.evaluate returns a diagnostic object now.
        evaluate:        async () => {
          evalCalls += 1;
          if (evalCalls === 1) return { via: null, hadHandler: false, hadHiddenId: false, hadVisibleBtn: false }; // fast path: nothing clickable
          // re-dispatch succeeds via the hidden button AND commits the add.
          mockWaiting = new Map([['5150', 88]]);
          return { via: 'hidden-id', hadHandler: false, hadHiddenId: true, hadVisibleBtn: false };
        },
        click:           async () => { throw new Error('page.click: Timeout 2000ms exceeded.'); },
        waitForFunction: async () => { throw new Error('unused: click threw first'); },
        textContent:     async () => '',
        screenshot:      async () => { throw new Error('no screenshots in tests'); },
        context:         () => ({ storageState: async () => ({}) }),
        on: () => {}, off: () => {},
      },
    };

    const result = await bot.fireClaimedSession(session);

    expect(result).not.toBeNull();            // did NOT concede to the cold path
    expect(result.success).toBe(true);
    expect(result.warmRefired).toBe(true);
    expect(result.viaArmedSession).toBe(true);
    expect(result.recoveredFromTimeout).toBe(true);
    expect(result.alreadyQueued).toBe(false); // genuine OUR-add landing
    expect(result.position).toBe(88);
    expect(evalCalls).toBeGreaterThanOrEqual(2); // re-dispatched at least once
    // Browser freed BEFORE the patient V Holding confirm — the pool must declog.
    expect(disposeOrder[0]).toBe('context-closed');
  });

  test('re-dispatch never succeeds → null (cold fallback preserved)', async () => {
    mockWaiting = new Map();                   // never lands
    const session = {
      driverId:      811,
      vehicleNumber: '4444',
      context:       { close: async () => {} },
      page: {
        isClosed:        () => false,
        evaluate:        async () => ({ via: null, hadHandler: false, hadHiddenId: false, hadVisibleBtn: false }), // every dispatch finds nothing
        click:           async () => { throw new Error('page.click: Timeout 2000ms exceeded.'); },
        waitForFunction: async () => { throw new Error('unused'); },
        textContent:     async () => '',
        screenshot:      async () => { throw new Error('no screenshots'); },
        context:         () => ({ storageState: async () => ({}) }),
        on: () => {}, off: () => {},
      },
    };

    const result = await bot.fireClaimedSession(session);
    expect(result).toBeNull();                 // exhausted → cold path, exactly as before
  });

  test('real confirm-timeout (click DID dispatch) does NOT warm re-fire', async () => {
    // Present in V Holding: the click dispatched (evaluate → true), the WAIT
    // screen just timed out. dispatchedAtMs is set ⇒ warm re-fire must be
    // skipped (the add is in flight; re-clicking would double-add). This is the
    // existing verify-on-timeout recovery, unchanged.
    mockWaiting = new Map([['9999', 57]]);
    let evalCalls = 0;
    const session = {
      driverId:      812,
      vehicleNumber: '9999',
      context:       { close: async () => {} },
      page: {
        isClosed:        () => false,
        evaluate:        async () => { evalCalls += 1; return { via: 'hidden-handler', hadHandler: true, hadHiddenId: true, hadVisibleBtn: true }; }, // dispatched
        click:           async () => {},
        waitForFunction: async () => { throw new Error('page.waitForFunction: Timeout 12000ms exceeded.'); },
        textContent:     async () => '',
        screenshot:      async () => { throw new Error('no screenshots'); },
        context:         () => ({ storageState: async () => ({}) }),
        on: () => {}, off: () => {},
      },
    };

    const result = await bot.fireClaimedSession(session);
    expect(result).not.toBeNull();
    expect(result.success).toBe(true);
    expect(result.recoveredFromTimeout).toBe(true);
    expect(result.warmRefired).toBeUndefined();  // the warm ladder was NOT taken
    expect(result.position).toBe(57);
    expect(evalCalls).toBe(1);                   // dispatched once, never re-clicked
  });
});

// Second layer: bound how many clicks DISPATCH at once (≈ vCPU count) so the
// same-tick batch can't starve the renderers into 2 s click timeouts in the
// first place (BOT_FIRE_DISPATCH_MAX). The primitive is tested directly — the
// over-admission fix in makeSemaphore is the subtle part.
describe('fire-dispatch concurrency cap (makeSemaphore)', () => {
  test('bounds concurrency at max and never over-admits under same-tick contention', async () => {
    const sem = bot._makeSemaphore(3);
    let active = 0, peak = 0, completed = 0;
    const task = () => sem.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; completed++;
    });
    await Promise.all(Array.from({ length: 20 }, task)); // 20 launched in one tick
    expect(peak).toBe(3);        // exactly the cap — never 4 (the over-admission bug)
    expect(completed).toBe(20);  // and every one still ran
    expect(active).toBe(0);
  });

  test('cap of 1 fully serializes', async () => {
    const sem = bot._makeSemaphore(1);
    let active = 0, peak = 0;
    const task = () => sem.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(1);
  });

  test('a throwing task still releases its slot (no permanent leak)', async () => {
    const sem = bot._makeSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await sem.run(async () => { ran = true; }); // slot freed ⇒ next task runs
    expect(ran).toBe(true);
  });
});

describe('dispatchAddInPage — returns the method used + reports failures', () => {
  test('returns the method name when the hidden handler fires', async () => {
    const page = { evaluate: async () => ({ via: 'hidden-handler', hadHandler: true, hadHiddenId: true, hadVisibleBtn: true }) };
    expect(await bot._dispatchAddInPage(page, 'Add To Queue', 'V1')).toBe('hidden-handler');
  });

  test('returns null AND warns when nothing is clickable', async () => {
    const page = { evaluate: async () => ({ via: null, hadHandler: false, hadHiddenId: false, hadVisibleBtn: false }) };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const via = await bot._dispatchAddInPage(page, 'Add To Queue', 'V2');
    const warned = warn.mock.calls.some((a) => String(a[0]).includes('NOTHING clickable') && String(a[0]).includes('#V2'));
    warn.mockRestore();
    expect(via).toBeNull();
    expect(warned).toBe(true);
  });

  test('WARNS when the hidden Blazor path is unavailable and it falls back to the visible button (the "wrong element name" case)', async () => {
    // handler + hidden id both missing (renamed) → degrades to visible-button.
    const page = { evaluate: async () => ({ via: 'visible-button', hadHandler: false, hadHiddenId: false, hadVisibleBtn: true }) };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const via = await bot._dispatchAddInPage(page, 'Add To Queue', 'V3');
    const warned = warn.mock.calls.some((a) => String(a[0]).includes('hidden Blazor path UNAVAILABLE') && String(a[0]).includes('handler=false'));
    warn.mockRestore();
    expect(via).toBe('visible-button');   // still fires — degraded, not broken
    expect(warned).toBe(true);            // …but we're TOLD the hidden path is gone
  });

  test('swallows page.evaluate errors → null (never throws)', async () => {
    const page = { evaluate: async () => { throw new Error('detached'); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const via = await bot._dispatchAddInPage(page, 'Add To Queue', 'V4');
    warn.mockRestore();
    expect(via).toBeNull();
  });
});
