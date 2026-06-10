/**
 * Integration tests — SOS routes
 *
 * Run independently: npx jest tests/api/sos.test.js
 */

jest.mock('../../src/services/botService', () => ({
  addToQueue: jest.fn().mockResolvedValue({ success: true, alreadyQueued: false, position: 1, durationMs: 100 }),
}));

const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll } = require('../helpers/db');
const { createDriver, createAdmin, driverCookie, adminCookie } = require('../helpers/fixtures');

const app = createApp();

beforeAll(async () => { await migrateUp(); });
afterEach(async () => { await truncateAll(); });

describe('POST /api/driver/sos', () => {
  test('rejects without auth', async () => {
    const res = await request(app).post('/api/driver/sos');
    expect(res.status).toBe(401);
  });

  test('creates an alert with coords + emits a row', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const res = await request(app)
      .post('/api/driver/sos')
      .set('Cookie', driverCookie(driver.id))
      .send({ lat: 32.7338, lng: -117.1933, accuracy: 12, message: 'flat tire' });

    expect(res.status).toBe(201);
    expect(res.body.alert.id).toBeDefined();
    expect(res.body.alert.status).toBe('active');
    expect(Number(res.body.alert.initial_lat)).toBeCloseTo(32.7338, 4);
    expect(res.body.alert.message).toBe('flat tire');

    const history = await db('sos_location_history').where({ alert_id: res.body.alert.id });
    expect(history).toHaveLength(1);
  });

  test('accepts an alert with no coords (geolocation pending)', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const res = await request(app)
      .post('/api/driver/sos')
      .set('Cookie', driverCookie(driver.id))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.alert.initial_lat).toBeNull();
  });

  test('works WITHOUT an active subscription (SOS must never be blocked)', async () => {
    const driver = await createDriver({
      email_verified_at: null,        // not even verified
      subscription_status: 'canceled',
    });
    const res = await request(app)
      .post('/api/driver/sos')
      .set('Cookie', driverCookie(driver.id))
      .send({ lat: 32.7, lng: -117.1 });
    expect(res.status).toBe(201);
  });

  test('dedupes — second call returns the existing open alert', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const cookie = driverCookie(driver.id);
    const first  = await request(app).post('/api/driver/sos').set('Cookie', cookie).send({ lat: 1, lng: 2 });
    const second = await request(app).post('/api/driver/sos').set('Cookie', cookie).send({ lat: 3, lng: 4 });
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.alert.id).toBe(first.body.alert.id);
  });
});

describe('POST /api/driver/sos/:id/location', () => {
  test('updates latest_lat/lng + appends history row', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const cookie = driverCookie(driver.id);
    const create = await request(app).post('/api/driver/sos').set('Cookie', cookie).send({});

    const res = await request(app)
      .post(`/api/driver/sos/${create.body.alert.id}/location`)
      .set('Cookie', cookie)
      .send({ lat: 32.5, lng: -117.2, accuracy: 8 });

    expect(res.status).toBe(200);
    expect(Number(res.body.alert.latest_lat)).toBeCloseTo(32.5, 4);

    const rows = await db('sos_location_history').where({ alert_id: create.body.alert.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('forbids updating another driver\'s alert', async () => {
    const owner  = await createDriver({ email: 'a@t.com', email_verified_at: new Date(), subscription_status: 'active' });
    const stranger = await createDriver({ email: 'b@t.com', email_verified_at: new Date(), subscription_status: 'active' });
    const create = await request(app).post('/api/driver/sos').set('Cookie', driverCookie(owner.id)).send({});
    const res = await request(app)
      .post(`/api/driver/sos/${create.body.alert.id}/location`)
      .set('Cookie', driverCookie(stranger.id))
      .send({ lat: 1, lng: 2 });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/sos/:id/acknowledge + /resolve', () => {
  test('admin can acknowledge then resolve an alert', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const admin  = await createAdmin();
    const create = await request(app).post('/api/driver/sos').set('Cookie', driverCookie(driver.id)).send({});

    const ackRes = await request(app)
      .post(`/api/admin/sos/${create.body.alert.id}/acknowledge`)
      .set('Cookie', adminCookie(admin.id));
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.alert.status).toBe('acknowledged');
    expect(ackRes.body.alert.acknowledged_by).toBe(admin.id);

    const resolveRes = await request(app)
      .post(`/api/admin/sos/${create.body.alert.id}/resolve`)
      .set('Cookie', adminCookie(admin.id));
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.alert.status).toBe('resolved');
    expect(resolveRes.body.alert.resolution_reason).toBe('admin_resolved');
  });

  test('cancelByDriver marks resolution_reason = driver_cancelled', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const cookie = driverCookie(driver.id);
    const create = await request(app).post('/api/driver/sos').set('Cookie', cookie).send({});

    const res = await request(app)
      .post(`/api/driver/sos/${create.body.alert.id}/cancel`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.alert.status).toBe('resolved');
    expect(res.body.alert.resolution_reason).toBe('driver_cancelled');
  });
});

describe('GET /api/admin/sos', () => {
  test('returns alerts + openCount', async () => {
    const driver = await createDriver({ email_verified_at: new Date(), subscription_status: 'active' });
    const admin  = await createAdmin();
    await request(app).post('/api/driver/sos').set('Cookie', driverCookie(driver.id)).send({});

    const res = await request(app)
      .get('/api/admin/sos')
      .set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.openCount).toBe(1);
    expect(res.body.alerts[0].driver_name).toBeDefined(); // join worked
  });
});
