/**
 * Fire-visibility watch (botService) — the live SAN-backlog signal.
 *
 * A fired vehicle not yet VISIBLE in V Holding has not been processed; the age
 * of the oldest such fire drives the onset backlog boost (monitorService).
 * These tests pin:
 *   1. oldestUnseenFireAgeMs counts only unseen fires past START_MS and
 *      within TIMEOUT_MS;
 *   2. one snapshot fetch resolves every due vehicle, marks it seen, and
 *      notifies the listener with its landing position exactly once;
 *   3. resolveFireVisibility ends the in-flight window;
 *   4. a failed snapshot fetch is survivable (retried next tick).
 *
 * Run: npx jest tests/services/fireVisibility.test.js
 */

process.env.BOT_FIRE_VIS_POLL_MS    = '1250';
process.env.BOT_FIRE_VIS_START_MS   = '2000';
process.env.BOT_FIRE_VIS_TIMEOUT_MS = '60000';
process.env.BOT_SESSION_PERSIST_PATH = '/tmp/fire-vis-test-sessions.json';

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

const bot = require('../../src/services/botService');
const {
  _beginFireVisibility: begin,
  _resolveFireVisibility: resolve,
  _fireVisPollOnce: pollOnce,
  _setFetchSnapshotFn: setSnapshot,
  _pendingFireVis: pending,
  oldestUnseenFireAgeMs,
  setFireVisibilityListener,
} = bot;

// monitorService _norm is used to match vehicles in the snapshot.
const { _norm } = require('../../src/services/monitorService');

const T0 = 1_700_000_000_000;
const snapshotWith = (entries) => async () => ({
  waiting: new Map(entries.map(([veh, pos]) => [_norm(veh), pos])),
  dispatched: new Map(),
});

afterEach(() => {
  pending.clear();
  setFireVisibilityListener(null);
  setSnapshot(async () => null);
});

describe('oldestUnseenFireAgeMs', () => {
  test('zero before START_MS, the oldest unseen age after, zero past TIMEOUT', () => {
    begin('4007', T0);
    begin('0082', T0 + 15000);
    expect(oldestUnseenFireAgeMs(T0 + 1500)).toBe(0);            // < START_MS
    expect(oldestUnseenFireAgeMs(T0 + 11000)).toBe(11000);       // oldest = #4007
    expect(oldestUnseenFireAgeMs(T0 + 70000)).toBe(55000);       // #4007 aged out (>60 s), #0082 counts
    expect(oldestUnseenFireAgeMs(T0 + 200000)).toBe(0);          // both stale
  });

  test('seen fires stop counting; resolved fires disappear', async () => {
    begin('4007', T0);
    setSnapshot(snapshotWith([['4007', 112]]));
    await pollOnce(T0 + 5000);                                    // marks seen
    expect(oldestUnseenFireAgeMs(T0 + 12000)).toBe(0);
    resolve('4007');
    expect(pending.size).toBe(0);
  });
});

describe('fireVisPollOnce', () => {
  test('one snapshot serves all due fires; listener gets each landing once', async () => {
    const seen = [];
    setFireVisibilityListener((e) => seen.push(e));
    begin('4007', T0);
    begin('0082', T0);
    begin('0003', T0 + 4500);                                     // not due yet at +5 s
    setSnapshot(snapshotWith([['4007', 112], ['0003', 130]]));    // #0082 not processed yet
    await pollOnce(T0 + 5000);
    expect(seen).toEqual([{ vehicleNumber: '4007', position: 112 }]);
    // #0082 still unseen → still the backlog signal.
    expect(oldestUnseenFireAgeMs(T0 + 5000)).toBe(5000);
    // Next tick: #0003 now due and visible; #4007 already seen → no re-notify.
    await pollOnce(T0 + 7000);
    expect(seen).toEqual([
      { vehicleNumber: '4007', position: 112 },
      { vehicleNumber: '0003', position: 130 },
    ]);
  });

  test('a failed snapshot fetch leaves everything pending (retry next tick)', async () => {
    begin('4007', T0);
    setSnapshot(async () => { throw new Error('SAN 502'); });
    await expect(pollOnce(T0 + 5000)).resolves.toBeUndefined();
    expect(oldestUnseenFireAgeMs(T0 + 5000)).toBe(5000);
  });

  test('entries past TIMEOUT_MS are pruned (crash-path hygiene)', async () => {
    begin('4007', T0);
    setSnapshot(snapshotWith([]));
    await pollOnce(T0 + 61000);
    expect(pending.size).toBe(0);
  });
});
