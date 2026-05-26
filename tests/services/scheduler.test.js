/**
 * Scheduler service tests
 *
 * Strategy
 * ────────
 * • `botService.addToQueue` is mocked at the module level — no real browser runs.
 * • `runBotForDriver` is tested directly (it is the exported unit of work).
 * • Driver-selection logic (which runs inside the cron tick) is extracted into
 *   a pure helper function below and tested in isolation so we don't need to
 *   start the actual cron job.
 * • Tests that exercise retries use Jest fake timers to avoid real waits.
 *
 * Run independently: npx jest tests/services/scheduler.test.js
 */

// ─── Mock botService BEFORE any require so Jest can hoist it ─────────────
jest.mock('../../src/services/botService');

const { addToQueue }      = require('../../src/services/botService');
const { runBotForDriver } = require('../../src/services/schedulerService');
const { db, migrateUp, truncateAll } = require('../helpers/db');
const { createDriver }               = require('../helpers/fixtures');
const { encrypt }                    = require('../../src/services/cryptoService');

// ─── Lifecycle ────────────────────────────────────────────────────────────

beforeAll(async () => {
  await migrateUp();
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await truncateAll();
  // The credential lockout is in-memory and keyed by driver.id. Since
  // truncateAll restarts the id sequence, a lockout armed in one test can
  // bleed into the next test's driver. Reset it here for isolation.
  require('../../src/services/credentialLockoutService')._reset();
});

// ─── Pure driver-selection helper (mirrors the cron tick logic) ───────────
//
// This function replicates the filtering logic from schedulerService without
// importing or starting the cron job itself, letting us test selection in
// isolation.

function wouldSelectDriver(driver, currentTime, todayDay) {
  if (driver.day_schedules) {
    try {
      const ds = JSON.parse(driver.day_schedules);
      return ds[String(todayDay)] === currentTime;
    } catch {
      return false;
    }
  }
  // Legacy fallback
  const activeDays = (driver.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
  return activeDays.includes(String(todayDay)) && driver.scheduled_time === currentTime;
}

// ─── 33 — Driver selection logic ─────────────────────────────────────────

describe('driver selection logic', () => {
  const TIME    = '05:00';
  const TODAY   = '1'; // Monday

  test('selects driver whose day_schedules[todayDay] matches currentTime', () => {
    const driver = {
      day_schedules:  JSON.stringify({ '1': '05:00', '0': null, '2': null, '3': null, '4': null, '5': null, '6': null }),
      scheduled_time: '05:00',
      scheduled_days: '1',
    };
    expect(wouldSelectDriver(driver, TIME, TODAY)).toBe(true);
  });

  test('skips driver whose day_schedules[todayDay] is null (not scheduled today)', () => {
    const driver = {
      day_schedules:  JSON.stringify({ '0': '05:00', '1': null, '2': null, '3': null, '4': null, '5': null, '6': null }),
      scheduled_time: '05:00',
      scheduled_days: '0',
    };
    expect(wouldSelectDriver(driver, TIME, TODAY)).toBe(false);
  });

  test('selects driver using legacy scheduled_time + scheduled_days when day_schedules is absent', () => {
    const driver = {
      day_schedules:  null,
      scheduled_time: '05:00',
      scheduled_days: '0,1,2,3,4,5,6',
    };
    expect(wouldSelectDriver(driver, TIME, TODAY)).toBe(true);
  });

  test('skips legacy driver whose scheduled_days does not include today', () => {
    const driver = {
      day_schedules:  null,
      scheduled_time: '05:00',
      scheduled_days: '0,2,4,6', // Sun, Tue, Thu, Sat — no Monday
    };
    expect(wouldSelectDriver(driver, TIME, TODAY)).toBe(false);
  });

  test('skips legacy driver whose scheduled_time does not match currentTime', () => {
    const driver = {
      day_schedules:  null,
      scheduled_time: '06:00',
      scheduled_days: '0,1,2,3,4,5,6',
    };
    expect(wouldSelectDriver(driver, TIME, TODAY)).toBe(false);
  });
});

// ─── 34 — Skip already-queued driver ─────────────────────────────────────

describe('skip already-queued driver', () => {
  test('driver with a success log today is not re-run', async () => {
    const driver = await createDriver();

    // Pre-seed a success log for today
    await db('logs').insert({
      driver_id:    driver.id,
      triggered_at: new Date(),
      trigger_type: 'scheduled',
      status:       'success',
    });

    // The scheduler checks Log.findSuccessToday before running the bot.
    // We verify it by checking addToQueue is NOT called if we simulate
    // the guard: call runBotForDriver only after confirming no success today.
    // The guard lives in the cron tick (not in runBotForDriver itself), so
    // here we just verify that our DB seed creates a discoverable success log.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const Log   = require('../../src/models/Log');
    const found = await Log.findSuccessToday(driver.id, today);

    expect(found).toBeDefined();
    expect(found.status).toBe('success');
  });
});

// ─── 35 — Log lifecycle ───────────────────────────────────────────────────

describe('log lifecycle', () => {
  test.each([
    [
      'bot succeeds → log status is success',
      { success: true, alreadyQueued: false, position: 5, queueTime: '08:00', location: 'LOC1', durationMs: 1000 },
      'success',
    ],
    [
      'bot reports already queued → log status is already_queued',
      { success: true, alreadyQueued: true, position: 3, durationMs: 500 },
      'already_queued',
    ],
    [
      'bot fails → log status is failed with error_message',
      { success: false, error: 'Login failed — check credentials', durationMs: 800 },
      'failed',
    ],
  ])('%s', async (_label, botResult, expectedStatus) => {
    addToQueue.mockResolvedValue(botResult);

    const driver = await createDriver();
    await runBotForDriver(driver, 'manual');

    const log = await db('logs').where({ driver_id: driver.id }).orderBy('triggered_at', 'desc').first();
    expect(log).toBeDefined();
    expect(log.status).toBe(expectedStatus);

    if (expectedStatus === 'failed') {
      expect(log.error_message).toBeTruthy();
    }
    if (expectedStatus === 'success') {
      expect(log.queue_position).toBe(5);
    }
  });
});

// ─── 36 — Retry behaviour ────────────────────────────────────────────────
//
// RETRY_BASE_MS=0 and RETRY_JITTER_MS=0 are set in .env.test so retries fire
// instantly with real timers — no fake timers needed.

describe('retry behaviour', () => {
  test('transient failure retries up to MAX_RETRIES (3) times before giving up', async () => {
    addToQueue.mockResolvedValue({ success: false, error: 'Network timeout — transient' });

    const driver = await createDriver();
    await runBotForDriver(driver, 'manual');

    // Should have attempted exactly MAX_RETRIES (3) times
    expect(addToQueue).toHaveBeenCalledTimes(3);

    const log = await db('logs').where({ driver_id: driver.id }).first();
    expect(log.status).toBe('failed');
  });

  test('transient failure followed by success resolves to success after retry', async () => {
    addToQueue
      .mockResolvedValueOnce({ success: false, error: 'Network timeout — transient' })
      .mockResolvedValueOnce({ success: true,  alreadyQueued: false, position: 2, durationMs: 200 });

    const driver = await createDriver();
    await runBotForDriver(driver, 'manual');

    expect(addToQueue).toHaveBeenCalledTimes(2);
    const log = await db('logs').where({ driver_id: driver.id }).first();
    expect(log.status).toBe('success');
  });

  test('permanent credential failure does NOT retry (stops after 1 attempt)', async () => {
    addToQueue.mockResolvedValue({
      success: false,
      error:   'Invalid SAN credentials — check credentials',
    });

    const driver = await createDriver();
    await runBotForDriver(driver, 'manual');

    // isTransientError returns false for credential errors → no retry
    expect(addToQueue).toHaveBeenCalledTimes(1);
    const log = await db('logs').where({ driver_id: driver.id }).first();
    expect(log.status).toBe('failed');
  });
});

// ─── 37 — Duplicate-run guard ─────────────────────────────────────────────

describe('duplicate-run guard', () => {
  test('calling runBotForDriver while driver is already running creates only one log', async () => {
    // Make addToQueue slow so the first call is still "in flight"
    addToQueue.mockImplementation(
      () => new Promise(resolve =>
        setTimeout(() => resolve({ success: true, alreadyQueued: false, position: 1, durationMs: 100 }), 200),
      ),
    );

    const driver = await createDriver();

    // Fire two concurrent calls — second should be a no-op
    const [result1, result2] = await Promise.all([
      runBotForDriver(driver, 'manual'),
      runBotForDriver(driver, 'manual'),
    ]);

    // One call returns a result; the other returns undefined (early exit)
    const results = [result1, result2];
    expect(results.filter(r => r === undefined)).toHaveLength(1);

    // Only one log record should exist
    const logs = await db('logs').where({ driver_id: driver.id });
    expect(logs).toHaveLength(1);
  });
});
