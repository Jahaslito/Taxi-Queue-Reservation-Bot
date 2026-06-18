/**
 * DB-level guarantees for the carryover-safe Log helpers added after the
 * 2026-06-15 fleet-wide outage. The core invariant: a REMOVE-type log can never
 * be read back as evidence the driver is in queue, and the durable carryover
 * marker is queryable for restart reconstruction.
 */
const { db, migrateUp, truncateAll } = require('../helpers/db');
const { createDriver }               = require('../helpers/fixtures');
const Log                            = require('../../src/models/Log');

const todayPT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// Insert a log at an explicit offset (ms) from now so "latest" ordering is
// deterministic regardless of insert speed.
const insertLog = (driverId, trigger_type, status, offsetMs = 0) =>
  db('logs').insert({
    driver_id: driverId,
    triggered_at: new Date(Date.now() + offsetMs),
    trigger_type,
    status,
  });

beforeAll(async () => { await migrateUp(); });
afterEach(async () => { await truncateAll(); });

describe('Log.findTodayLatestAdd() — remove-type logs never count as "in queue"', () => {
  test('ignores a carryover_cleanup success even when it is the most recent log', async () => {
    const driver = await createDriver();
    await insertLog(driver.id, 'position_schedule', 'success', -2000); // earlier ADD
    await insertLog(driver.id, 'carryover_cleanup', 'success',     0); // later REMOVE (the 06-15 trap)

    const row = await Log.findTodayLatestAdd(driver.id, todayPT());
    expect(row).toBeTruthy();
    expect(row.trigger_type).toBe('position_schedule'); // the ADD, not the later remove
  });

  test('returns null when the only logs today are removes', async () => {
    const driver = await createDriver();
    await insertLog(driver.id, 'carryover_cleanup', 'success');
    await insertLog(driver.id, 'manual_remove',     'success');

    const row = await Log.findTodayLatestAdd(driver.id, todayPT());
    expect(row).toBeFalsy(); // → hasBeenSeen=false, the whole point
  });
});

describe('Log.wasCarryoverToday()', () => {
  test('true when a carryover_marker exists today, false otherwise', async () => {
    const leftover = await createDriver();
    const fresh    = await createDriver();
    await insertLog(leftover.id, 'carryover_marker', 'info');

    expect(await Log.wasCarryoverToday(leftover.id, todayPT())).toBe(true);
    expect(await Log.wasCarryoverToday(fresh.id,    todayPT())).toBe(false);
  });
});

describe('Log.loadTodayContext() — batch restart context', () => {
  test('latestAddByDriver excludes removes; carryoverByDriver tracks markers', async () => {
    const driver = await createDriver();
    await insertLog(driver.id, 'monitor_requeue',  'success', -3000);
    await insertLog(driver.id, 'carryover_cleanup','success',     0); // must be ignored for "seen"
    await insertLog(driver.id, 'carryover_marker', 'info',    -5000);

    const ctx = await Log.loadTodayContext([driver.id], todayPT());

    expect(ctx.latestAddByDriver.get(driver.id).trigger_type).toBe('monitor_requeue');
    expect(ctx.carryoverByDriver.has(driver.id)).toBe(true);
  });

  test('empty driver list → empty maps (no crash)', async () => {
    const ctx = await Log.loadTodayContext([], todayPT());
    expect(ctx.latestAddByDriver.size).toBe(0);
    expect(ctx.carryoverByDriver.size).toBe(0);
  });
});

describe('Log.search()/count() — carryover markers ARE shown in the admin activity log', () => {
  test('a carryover_marker row appears in search results and the count', async () => {
    const driver = await createDriver();
    await insertLog(driver.id, 'carryover_marker', 'info');
    await insertLog(driver.id, 'position_schedule', 'success');

    const rows = await Log.search({});
    expect(rows.some((r) => r.trigger_type === 'carryover_marker')).toBe(true);
    expect(rows.some((r) => r.trigger_type === 'position_schedule')).toBe(true);

    const { count } = await Log.count({});
    expect(Number(count)).toBe(2); // both the marker and the position_schedule row
  });
});

describe('Log.findByDriver()/countByDriver() — carryover markers are hidden from the driver', () => {
  test('a carryover_marker row never reaches the driver-facing history', async () => {
    const driver = await createDriver();
    await insertLog(driver.id, 'carryover_marker', 'info');
    await insertLog(driver.id, 'position_schedule', 'success');

    const rows = await Log.findByDriver(driver.id, {});
    expect(rows.every((r) => r.trigger_type !== 'carryover_marker')).toBe(true);
    expect(rows.some((r) => r.trigger_type === 'position_schedule')).toBe(true);

    const { count } = await Log.countByDriver(driver.id);
    expect(Number(count)).toBe(1); // only the position_schedule row
  });
});
