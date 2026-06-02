/**
 * Integration tests — Driver routes (/api/driver/*)
 *
 * Run independently: npx jest tests/api/driver.test.js
 */

// Mock botService at the top level (Jest hoists this before any require).
jest.mock('../../src/services/botService', () => ({
  addToQueue: jest.fn().mockResolvedValue({
    success: true, alreadyQueued: false, position: 1, durationMs: 100,
  }),
}));

const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll }                             = require('../helpers/db');
const { createDriver, adminCookie, driverCookie, createAdmin }   = require('../helpers/fixtures');

const app = createApp();

// ─── Shared state ─────────────────────────────────────────────────────────
let driver, dCookie;

// ─── Lifecycle ────────────────────────────────────────────────────────────

beforeAll(async () => {
  await migrateUp();
});

beforeEach(async () => {
  driver  = await createDriver({ email: `driver_${Date.now()}@test.com` });
  dCookie = driverCookie(driver.id);
});

afterEach(async () => {
  await truncateAll();
});

// ─── 25 — Auth barrier (test.each over all driver endpoints) ─────────────

describe('auth barrier', () => {
  const ENDPOINTS = [
    ['get',  '/api/driver/profile'],
    ['put',  '/api/driver/profile'],
    ['get',  '/api/driver/logs'],
    ['get',  '/api/driver/status/today'],
    ['post', '/api/driver/trigger'],
  ];

  test.each(ENDPOINTS)('%s %s — no cookie → 401', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  test.each(ENDPOINTS)('%s %s — admin cookie → 403', async (method, path) => {
    const admin = await createAdmin();
    const res = await request(app)[method](path).set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(403);
  });
});

// ─── 26 — Data isolation ─────────────────────────────────────────────────

describe('data isolation between drivers', () => {
  test("Driver A's cookie cannot read Driver B's logs", async () => {
    const driverB = await createDriver();

    // Seed a log for driver B
    await db('logs').insert({
      driver_id:    driverB.id,
      triggered_at: new Date(),
      trigger_type: 'manual',
      status:       'success',
    });

    // Request logs using driver A's cookie
    const res = await request(app)
      .get('/api/driver/logs')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    const returnedDriverIds = res.body.logs.map(l => l.driver_id);
    expect(returnedDriverIds.every(id => id === driver.id)).toBe(true);
  });
});

// ─── 27 — Get profile ────────────────────────────────────────────────────

describe('GET /api/driver/profile', () => {
  test('returns driver data without any credential fields', async () => {
    const res = await request(app)
      .get('/api/driver/profile')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', driver.id);
    expect(res.body).not.toHaveProperty('app_password');
    expect(res.body).not.toHaveProperty('san_password');
  });
});

// ─── 28 — Update profile ─────────────────────────────────────────────────

describe('PUT /api/driver/profile', () => {
  test('updates allowed fields and returns updated driver', async () => {
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ name: 'Updated Driver Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Driver Name');
  });

  test('changing password without currentPassword returns 400', async () => {
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ newAppPassword: 'newpass123' }); // no currentPassword

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('changing password with wrong currentPassword returns 400', async () => {
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ newAppPassword: 'newpass123', currentPassword: 'wrongcurrentpass' });

    expect(res.status).toBe(400);
  });

  test('correct password change: new password works, old one is rejected', async () => {
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ newAppPassword: 'brandnewpass', currentPassword: driver.plainPassword });

    const oldLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: driver.vehicle_number, appPassword: driver.plainPassword });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: driver.vehicle_number, appPassword: 'brandnewpass' });
    expect(newLogin.status).toBe(200);
  });

  // 32 — Validation (test.each for format errors)
  test.each([
    ['scheduledTime invalid',     { scheduledTime: '25:61' }],
    ['scheduledTime no padding',  { scheduledTime: '5:00' }],
    ['scheduledDays out of range',{ scheduledDays: '0,1,7' }],
  ])('returns 400 when %s', async (_label, body) => {
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ─── 29 — Get logs ───────────────────────────────────────────────────────

describe('GET /api/driver/logs', () => {
  async function seedLog(driverId, overrides = {}) {
    await db('logs').insert({
      driver_id:    driverId,
      triggered_at: new Date(),
      trigger_type: 'manual',
      status:       'success',
      ...overrides,
    });
  }

  test('returns paginated structure containing only own logs', async () => {
    await seedLog(driver.id);
    const otherDriver = await createDriver();
    await seedLog(otherDriver.id); // log for another driver

    const res = await request(app)
      .get('/api/driver/logs')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      logs:   expect.any(Array),
      total:  expect.any(Number),
      limit:  expect.any(Number),
      offset: expect.any(Number),
    });
    // All returned logs belong to the authenticated driver
    res.body.logs.forEach(log => expect(log.driver_id).toBe(driver.id));
  });

  test('limit and offset page correctly', async () => {
    await Promise.all([seedLog(driver.id), seedLog(driver.id), seedLog(driver.id)]);

    const page1 = await request(app).get('/api/driver/logs?limit=2&offset=0').set('Cookie', dCookie);
    const page2 = await request(app).get('/api/driver/logs?limit=2&offset=2').set('Cookie', dCookie);

    expect(page1.body.logs).toHaveLength(2);
    const ids1 = page1.body.logs.map(l => l.id);
    const ids2 = page2.body.logs.map(l => l.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});

// ─── 30 — Today status ───────────────────────────────────────────────────

describe('GET /api/driver/status/today', () => {
  test('returns { todayLog: null, driver } when no bot has run today', async () => {
    const res = await request(app)
      .get('/api/driver/status/today')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('driver');
    expect(res.body.todayLog).toBeNull();
  });

  test('returns the latest log after a run today', async () => {
    // Insert a log timestamped now (guaranteed to be "today" in any timezone)
    await db('logs').insert({
      driver_id:    driver.id,
      triggered_at: new Date(),
      trigger_type: 'manual',
      status:       'success',
      queue_position: 5,
    });

    const res = await request(app)
      .get('/api/driver/status/today')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    expect(res.body.todayLog).not.toBeNull();
    expect(res.body.todayLog.status).toBe('success');
    expect(res.body.todayLog.driver_id).toBe(driver.id);
  });
});

// ─── 32 — Position claim exclusivity ─────────────────────────────────────────

describe('PUT /api/driver/profile — position claim exclusivity', () => {
  test('driver can save a day_positions schedule when the slot is free', async () => {
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 200 }) });

    expect(res.status).toBe(200);
    expect(res.body.day_positions).toBeTruthy();
  });

  test('second driver claiming the same (day, position) gets 409', async () => {
    // Driver A claims Friday position 300
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 300 }) });

    // Driver B tries to claim the same slot
    const driverB = await createDriver();
    const cookieB = driverCookie(driverB.id);
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', cookieB)
      .send({ dayPositions: JSON.stringify({ '5': 300 }) });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/300/);
    expect(res.body.error).toMatch(/Friday/i);
  });

  test('driver can re-save their own existing position without conflict', async () => {
    // Save Friday 200
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 200 }) });

    // Save Friday 200 again (same slot, same driver) — should succeed
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 200 }) });

    expect(res.status).toBe(200);
  });

  test('same position number on a different day does not conflict', async () => {
    // Driver A: Friday 200
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 200 }) });

    // Driver B: Saturday 200 — different day, should succeed
    const driverB = await createDriver();
    const cookieB = driverCookie(driverB.id);
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', cookieB)
      .send({ dayPositions: JSON.stringify({ '6': 200 }) });

    expect(res.status).toBe(200);
  });

  test('switching to time-based schedule releases position claims', async () => {
    // Driver A claims Friday 400
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ dayPositions: JSON.stringify({ '5': 400 }) });

    // Driver A switches to time-based — releases the claim
    await request(app)
      .put('/api/driver/profile')
      .set('Cookie', dCookie)
      .send({ daySchedules: JSON.stringify({ '5': '06:00' }) });

    // Driver B can now claim Friday 400
    const driverB = await createDriver();
    const cookieB = driverCookie(driverB.id);
    const res = await request(app)
      .put('/api/driver/profile')
      .set('Cookie', cookieB)
      .send({ dayPositions: JSON.stringify({ '5': 400 }) });

    expect(res.status).toBe(200);
  });
});

// ─── 31 — Trigger self ───────────────────────────────────────────────────

describe('POST /api/driver/trigger', () => {
  test('active driver returns 200 immediately with a message', async () => {
    const res = await request(app)
      .post('/api/driver/trigger')
      .set('Cookie', dCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message');
  });

  test('inactive driver returns 403 with accountInactive flag', async () => {
    // Middleware contract (updated 2026-05-30): credentials WERE valid (so
    // 401 would be misleading), but the account is deactivated. 403 + the
    // accountInactive flag is what the client uses to route to the
    // contact-admin screen instead of bouncing back to login.
    await db('drivers').where({ id: driver.id }).update({ is_active: false });

    const res = await request(app)
      .post('/api/driver/trigger')
      .set('Cookie', dCookie);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      accountInactive: true,
      error: expect.stringMatching(/inactive/i),
    }));
  });
});
