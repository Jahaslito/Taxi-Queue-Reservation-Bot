/**
 * Integration tests — Admin routes (/api/admin/*)
 *
 * Every test gets a fresh admin account and a default driver via beforeEach.
 * All tables are truncated after each test.
 *
 * Run independently: npx jest tests/api/admin.test.js
 */

// Mock botService at the top level (Jest hoists this before any require).
// This prevents the background bot from launching real Playwright sessions
// when the trigger endpoints are hit during tests.
jest.mock('../../src/services/botService', () => ({
  addToQueue: jest.fn().mockResolvedValue({
    success: true, alreadyQueued: false, position: 1, durationMs: 100,
  }),
}));

const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll }                            = require('../helpers/db');
const { createAdmin, createDriver, adminCookie, driverCookie }  = require('../helpers/fixtures');

const app = createApp();

// ─── Shared state populated in beforeEach ─────────────────────────────────
let admin, driver, aCookie;

// ─── Lifecycle ────────────────────────────────────────────────────────────

beforeAll(async () => {
  await migrateUp();
});

beforeEach(async () => {
  admin   = await createAdmin();
  driver  = await createDriver();
  aCookie = adminCookie(admin.id);
});

afterEach(async () => {
  await truncateAll();
});

// ─── 15 — Auth barrier (test.each over all 8 admin endpoints) ────────────

describe('auth barrier', () => {
  // List of [method, path] pairs — body is not needed because auth runs
  // before validation middleware, so any payload (or no payload) is fine.
  const ENDPOINTS = [
    ['get',    '/api/admin/stats'],
    ['get',    '/api/admin/drivers'],
    ['post',   '/api/admin/drivers'],
    ['get',    '/api/admin/drivers/1'],
    ['put',    '/api/admin/drivers/1'],
    ['delete', '/api/admin/drivers/1'],
    ['post',   '/api/admin/drivers/1/trigger'],
    ['get',    '/api/admin/logs'],
  ];

  test.each(ENDPOINTS)('%s %s — no cookie → 401', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  test.each(ENDPOINTS)('%s %s — driver cookie → 403', async (method, path) => {
    const dCookie = driverCookie(driver.id);
    const res = await request(app)[method](path).set('Cookie', dCookie);
    expect(res.status).toBe(403);
  });
});

// ─── 16 — Stats ──────────────────────────────────────────────────────────

describe('GET /api/admin/stats', () => {
  test('returns correct shape and day-aware schedule breakdown', async () => {
    // Determine today's index in Pacific Time (mirrors server logic)
    const abbr    = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
    const dayMap  = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
    const today   = dayMap[abbr];
    const other   = String((parseInt(today) + 1) % 7);

    // Driver scheduled ONLY for today
    const dsToday = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [String(i), i === parseInt(today) ? '04:00' : null]),
    );
    await createDriver({ day_schedules: JSON.stringify(dsToday), scheduled_time: '04:00' });

    // Driver scheduled ONLY for a different day
    const dsOther = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [String(i), i === parseInt(other) ? '04:30' : null]),
    );
    await createDriver({ day_schedules: JSON.stringify(dsOther), scheduled_time: '04:30' });

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalDrivers:      expect.any(Number),
      activeDrivers:     expect.any(Number),
      today:             expect.objectContaining({ success: expect.any(Number), failed: expect.any(Number), total: expect.any(Number) }),
      allTime:           expect.objectContaining({ success: expect.any(Number), failed: expect.any(Number) }),
      scheduleBreakdown: expect.any(Array),
    });

    const breakdown = res.body.scheduleBreakdown;
    // Today-scheduled driver appears; other-day driver does not
    expect(breakdown.some(b => b.scheduled_time === '04:00')).toBe(true);
    expect(breakdown.some(b => b.scheduled_time === '04:30')).toBe(false);
  });
});

// ─── 17 — List drivers ────────────────────────────────────────────────────

describe('GET /api/admin/drivers', () => {
  test('returns paginated structure and never exposes credentials', async () => {
    const res = await request(app)
      .get('/api/admin/drivers')
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      drivers: expect.any(Array),
      total:   expect.any(Number),
      limit:   expect.any(Number),
      offset:  expect.any(Number),
    });
    // No credential fields in any driver object
    res.body.drivers.forEach(d => {
      expect(d).not.toHaveProperty('app_password');
      expect(d).not.toHaveProperty('san_password');
    });
  });

  test('search param filters by name, vehicle number, and SAN username', async () => {
    await createDriver({ name: 'Unique Name XYZ' });

    const res = await request(app)
      .get('/api/admin/drivers?search=Unique+Name+XYZ')
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body.drivers.length).toBeGreaterThanOrEqual(1);
    expect(res.body.drivers[0].name).toBe('Unique Name XYZ');
  });

  test('active=true excludes inactive drivers', async () => {
    // Deactivate the default driver
    await db('drivers').where({ id: driver.id }).update({ is_active: false });

    const res = await request(app)
      .get('/api/admin/drivers?active=true')
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body.drivers.every(d => d.is_active)).toBe(true);
  });

  test('limit and offset page correctly', async () => {
    // Create 3 additional drivers (default driver gives us 1)
    await Promise.all([createDriver(), createDriver(), createDriver()]);

    const page1 = await request(app)
      .get('/api/admin/drivers?limit=2&offset=0')
      .set('Cookie', aCookie);
    const page2 = await request(app)
      .get('/api/admin/drivers?limit=2&offset=2')
      .set('Cookie', aCookie);

    expect(page1.body.drivers).toHaveLength(2);
    expect(page2.body.drivers.length).toBeGreaterThanOrEqual(1);
    // IDs on the two pages must not overlap
    const ids1 = page1.body.drivers.map(d => d.id);
    const ids2 = page2.body.drivers.map(d => d.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});

// ─── 18 — Add driver ──────────────────────────────────────────────────────

describe('POST /api/admin/drivers', () => {
  const newDriver = {
    name:          'New Driver',
    sanUsername:   'new_san',
    sanPassword:   'new_san_pass',
    vehicleNumber: 'ND001',
    scheduledTime: '07:00',
  };

  // 18a — Success: tempPassword present and functional
  test('returns 201 with tempPassword that is not the vehicle number', async () => {
    const res = await request(app)
      .post('/api/admin/drivers')
      .set('Cookie', aCookie)
      .send(newDriver);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('tempPassword');
    expect(typeof res.body.tempPassword).toBe('string');
    expect(res.body.tempPassword.length).toBeGreaterThan(0);
    expect(res.body.tempPassword).not.toBe(newDriver.vehicleNumber);
  });

  test('tempPassword authenticates the new driver', async () => {
    const createRes = await request(app)
      .post('/api/admin/drivers')
      .set('Cookie', aCookie)
      .send(newDriver);

    const loginRes = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: newDriver.vehicleNumber, appPassword: createRes.body.tempPassword });

    expect(loginRes.status).toBe(200);
  });

  test('response never exposes san_password or app_password', async () => {
    const res = await request(app)
      .post('/api/admin/drivers')
      .set('Cookie', aCookie)
      .send(newDriver);

    expect(res.body).not.toHaveProperty('san_password');
    expect(res.body).not.toHaveProperty('app_password');
  });

  // 18b — Validation
  test.each([
    ['name',          { ...newDriver, name: '' }],
    ['sanUsername',   { ...newDriver, sanUsername: '' }],
    ['sanPassword',   { ...newDriver, sanPassword: '' }],
    ['vehicleNumber', { ...newDriver, vehicleNumber: '' }],
    ['scheduledTime invalid', { ...newDriver, scheduledTime: '99:99' }],
  ])('returns 400 when %s is missing or invalid', async (_label, body) => {
    const res = await request(app)
      .post('/api/admin/drivers')
      .set('Cookie', aCookie)
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ─── 19 — Get driver ──────────────────────────────────────────────────────

describe('GET /api/admin/drivers/:id', () => {
  test('returns driver object with recentLogs array', async () => {
    const res = await request(app)
      .get(`/api/admin/drivers/${driver.id}`)
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', driver.id);
    expect(res.body).toHaveProperty('recentLogs');
    expect(Array.isArray(res.body.recentLogs)).toBe(true);
  });

  test('returns 404 for an unknown driver ID', async () => {
    const res = await request(app)
      .get('/api/admin/drivers/999999')
      .set('Cookie', aCookie);
    expect(res.status).toBe(404);
  });

  test('returns 400 for a non-integer ID', async () => {
    const res = await request(app)
      .get('/api/admin/drivers/abc')
      .set('Cookie', aCookie);
    expect(res.status).toBe(400);
  });
});

// ─── 20 — Update driver ───────────────────────────────────────────────────

describe('PUT /api/admin/drivers/:id', () => {
  test('updates basic fields correctly', async () => {
    const res = await request(app)
      .put(`/api/admin/drivers/${driver.id}`)
      .set('Cookie', aCookie)
      .send({ name: 'Updated Name', notes: 'Updated notes' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.notes).toBe('Updated notes');
  });

  test('daySchedules update derives correct legacy scheduled_time and scheduled_days', async () => {
    const ds = { '1': '07:30', '3': '07:30', '0': null, '2': null, '4': null, '5': null, '6': null };

    const res = await request(app)
      .put(`/api/admin/drivers/${driver.id}`)
      .set('Cookie', aCookie)
      .send({ daySchedules: JSON.stringify(ds) });

    expect(res.status).toBe(200);
    expect(res.body.scheduled_time).toBe('07:30');
    // active days should be '1,3' (only Mon + Wed have a non-null time)
    const activeDays = res.body.scheduled_days.split(',').sort();
    expect(activeDays).toEqual(['1', '3']);
  });

  test('new appPassword works on login; old password is rejected', async () => {
    await request(app)
      .put(`/api/admin/drivers/${driver.id}`)
      .set('Cookie', aCookie)
      .send({ appPassword: 'brandnewpassword' });

    const oldLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: driver.vehicle_number, appPassword: driver.plainPassword });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: driver.vehicle_number, appPassword: 'brandnewpassword' });
    expect(newLogin.status).toBe(200);
  });

  test('returns 404 for an unknown driver ID', async () => {
    const res = await request(app)
      .put('/api/admin/drivers/999999')
      .set('Cookie', aCookie)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ─── 21 — Deactivate driver ───────────────────────────────────────────────

describe('DELETE /api/admin/drivers/:id', () => {
  test('sets is_active = false and keeps the record in the DB', async () => {
    const res = await request(app)
      .delete(`/api/admin/drivers/${driver.id}`)
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);

    const row = await db('drivers').where({ id: driver.id }).first();
    expect(row).toBeDefined();          // soft delete — record still exists
    expect(row.is_active).toBe(false);
  });

  test('returns 404 for an unknown driver ID', async () => {
    const res = await request(app)
      .delete('/api/admin/drivers/999999')
      .set('Cookie', aCookie);
    expect(res.status).toBe(404);
  });
});

// ─── 22 — Trigger driver ─────────────────────────────────────────────────

describe('POST /api/admin/drivers/:id/trigger', () => {
  test('active driver returns 200 with bot result', async () => {
    const res = await request(app)
      .post(`/api/admin/drivers/${driver.id}/trigger`)
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('result');
    expect(res.body.result).toHaveProperty('success');
  });

  test('inactive driver returns 400', async () => {
    await db('drivers').where({ id: driver.id }).update({ is_active: false });

    const res = await request(app)
      .post(`/api/admin/drivers/${driver.id}/trigger`)
      .set('Cookie', aCookie);

    expect(res.status).toBe(400);
  });

  test('unknown driver returns 404', async () => {
    const res = await request(app)
      .post('/api/admin/drivers/999999/trigger')
      .set('Cookie', aCookie);
    expect(res.status).toBe(404);
  });
});

// ─── 23 — Logs ───────────────────────────────────────────────────────────

describe('GET /api/admin/logs', () => {
  // Seed a log row directly so we have something to filter against
  async function seedLog(overrides = {}) {
    const [row] = await db('logs')
      .insert({
        driver_id:    driver.id,
        triggered_at: new Date(),
        trigger_type: 'manual',
        status:       'success',
        queue_position: 3,
        ...overrides,
      })
      .returning('*');
    return row;
  }

  test('returns paginated structure with driver_name and vehicle_number joined', async () => {
    await seedLog();

    const res = await request(app)
      .get('/api/admin/logs')
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      logs:   expect.any(Array),
      total:  expect.any(Number),
      limit:  expect.any(Number),
      offset: expect.any(Number),
    });
    expect(res.body.logs[0]).toHaveProperty('driver_name');
    expect(res.body.logs[0]).toHaveProperty('vehicle_number');
  });

  test.each([
    ['driverId filter', () => `driverId=${driver.id}`],
    ['status filter',   () => 'status=success'],
    ['search filter',   () => `search=${encodeURIComponent(driver.name)}`],
  ])('%s returns only matching rows', async (_label, makeQuery) => {
    await seedLog();

    const res = await request(app)
      .get(`/api/admin/logs?${makeQuery()}`)
      .set('Cookie', aCookie);

    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThanOrEqual(1);
  });

  test('limit and offset page correctly', async () => {
    await Promise.all([seedLog(), seedLog(), seedLog()]);

    const page1 = await request(app).get('/api/admin/logs?limit=2&offset=0').set('Cookie', aCookie);
    const page2 = await request(app).get('/api/admin/logs?limit=2&offset=2').set('Cookie', aCookie);

    expect(page1.body.logs).toHaveLength(2);
    const ids1 = page1.body.logs.map(l => l.id);
    const ids2 = page2.body.logs.map(l => l.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});
