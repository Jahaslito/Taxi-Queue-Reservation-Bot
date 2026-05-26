/**
 * Integration tests — Auth routes (/api/auth/*)
 *
 * Covers: registration, login (driver + admin), password reset, logout,
 * and credential-leak assertions.
 *
 * Rate-limit tests live in tests/api/rateLimit.test.js so they get a
 * fresh module registry (and therefore a fresh in-memory limiter).
 *
 * Run independently: npx jest tests/api/auth.test.js
 */
const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll }               = require('../helpers/db');
const { createAdmin, createDriver, validRegBody }  = require('../helpers/fixtures');

const app = createApp();

// ─── Lifecycle ────────────────────────────────────────────────────────────

beforeAll(async () => {
  await migrateUp();
});

afterEach(async () => {
  await truncateAll();
});

// ─── POST /api/auth/driver/register ───────────────────────────────────────

describe('POST /api/auth/driver/register', () => {
  // 5 — Validation (test.each collapses all field/format checks into one block)
  test.each([
    ['name is empty',               { ...validRegBody, name: '' }],
    ['appPassword is empty',        { ...validRegBody, appPassword: '' }],
    ['sanUsername is empty',        { ...validRegBody, sanUsername: '' }],
    ['sanPassword is empty',        { ...validRegBody, sanPassword: '' }],
    ['vehicleNumber is empty',      { ...validRegBody, vehicleNumber: '' }],
    // scheduledTime is now optional — drivers pick time-based vs position-based
    // mode post-registration from the dashboard. Format is still validated
    // if a value is supplied.
    ['scheduledTime is invalid',    { ...validRegBody, scheduledTime: '25:00' }],
    ['scheduledTime has no padding',{ ...validRegBody, scheduledTime: '5:00' }],
    ['scheduledDays has day 7',     { ...validRegBody, scheduledDays: '0,7' }],
    ['email is malformed',          { ...validRegBody, email: 'not-an-email' }],
  ])('returns 400 when %s', async (_label, body) => {
    const res = await request(app)
      .post('/api/auth/driver/register')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  // 6 — Success path
  test('valid payload returns 201, sets httpOnly cookie, omits credentials', async () => {
    const res = await request(app)
      .post('/api/auth/driver/register')
      .send(validRegBody);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('driver');
    expect(res.body.driver).not.toHaveProperty('app_password');
    expect(res.body.driver).not.toHaveProperty('san_password');

    const cookies = res.headers['set-cookie'] ?? [];
    const tokenCookie = cookies.find(c => c.startsWith('token='));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
    // 'Lax' (not 'Strict') so the cookie rides along on top-level navigations
    // from external sites — required for the Stripe Checkout return flow.
    expect(tokenCookie).toMatch(/SameSite=Lax/i);
  });

  // Registration without scheduledTime succeeds and stores null schedule fields.
  // Drivers pick their schedule mode (time-based vs position-based) from the
  // dashboard after creating the account — registering must NOT silently set
  // a default 05:00 schedule for everyone, since that caused drivers who later
  // chose position-based scheduling to still get auto-checked-in at 5 AM.
  test('registration without scheduledTime succeeds and leaves schedule fields null', async () => {
    const { scheduledTime, scheduledDays, daySchedules, ...bodyWithoutSchedule } = validRegBody;
    const res = await request(app)
      .post('/api/auth/driver/register')
      .send(bodyWithoutSchedule);

    expect(res.status).toBe(201);
    expect(res.body.driver).toHaveProperty('id');

    const row = await db('drivers').where({ id: res.body.driver.id }).first();
    expect(row.scheduled_time).toBeNull();
    expect(row.scheduled_days).toBeNull();
    expect(row.day_schedules).toBeNull();
  });

  // 7 — Duplicate email
  test('duplicate email returns 409', async () => {
    await request(app).post('/api/auth/driver/register').send(validRegBody);

    const res = await request(app)
      .post('/api/auth/driver/register')
      .send({ ...validRegBody, vehicleNumber: 'DIFFERENT001' }); // same email

    expect(res.status).toBe(409);
  });
});

// ─── POST /api/auth/driver/login ──────────────────────────────────────────

describe('POST /api/auth/driver/login', () => {
  let driver;
  beforeEach(async () => {
    driver = await createDriver({ email: 'login@test.com', vehicle_number: 'LG001' });
  });

  // 8 — Valid login paths + invalid credentials
  test('valid credentials by email return 200 + cookie without credentials', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: driver.email, appPassword: driver.plainPassword });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('driver');
    expect(res.body.driver).not.toHaveProperty('app_password');
    expect(res.body.driver).not.toHaveProperty('san_password');
    const cookies = res.headers['set-cookie'] ?? [];
    expect(cookies.some(c => c.startsWith('token='))).toBe(true);
  });

  test('valid credentials by vehicle number return 200 + cookie', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ vehicleNumber: driver.vehicle_number, appPassword: driver.plainPassword });

    expect(res.status).toBe(200);
  });

  test('wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: driver.email, appPassword: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  test('unknown account returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: 'nobody@example.com', appPassword: 'anything' });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/auth/admin/login ───────────────────────────────────────────

describe('POST /api/auth/admin/login', () => {
  let admin;
  beforeEach(async () => {
    admin = await createAdmin();
  });

  // 9 — Admin login
  test('valid credentials return 200 + cookie without password_hash', async () => {
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.plainPassword });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('admin');
    expect(res.body.admin).not.toHaveProperty('password_hash');
    const cookies = res.headers['set-cookie'] ?? [];
    expect(cookies.some(c => c.startsWith('token='))).toBe(true);
  });

  test('wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  test('unknown username returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'nobody', password: 'anything' });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/auth/driver/forgot-password + reset-password ──────────────────
// The flow is two steps:
//   1. POST /forgot-password {email}  → stores a token in DB, sends email (mocked)
//   2. POST /reset-password {token, newPassword} → completes the reset
// Tests fetch the token directly from the DB since email is not sent in the test env.

describe('password reset flow', () => {
  let driver;
  beforeEach(async () => {
    driver = await createDriver({ email: 'reset@test.com', vehicle_number: 'RST001' });
  });

  // Helper: trigger forgot-password and return the token stored in the DB
  async function requestResetToken(email) {
    await request(app).post('/api/auth/driver/forgot-password').send({ email });
    const row = await db('drivers').where({ email }).first();
    return row?.password_reset_token ?? null;
  }

  test('forgot-password always returns 200 (prevents enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/driver/forgot-password')
      .send({ email: driver.email });
    expect(res.status).toBe(200);
  });

  test('forgot-password for unknown email still returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/driver/forgot-password')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
  });

  test('forgot-password stores a reset token in the DB for known email', async () => {
    const token = await requestResetToken(driver.email);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  test('valid token + new password returns 200', async () => {
    const token = await requestResetToken(driver.email);
    const res = await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token, newPassword: 'NewPass123!' });
    expect(res.status).toBe(200);
  });

  test('new password authenticates the driver on next login', async () => {
    const token = await requestResetToken(driver.email);
    await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token, newPassword: 'NewPass123!' });

    const loginRes = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: driver.email, appPassword: 'NewPass123!' });
    expect(loginRes.status).toBe(200);
  });

  test('old password is rejected after reset', async () => {
    const token = await requestResetToken(driver.email);
    await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token, newPassword: 'NewPass123!' });

    const loginRes = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: driver.email, appPassword: driver.plainPassword });
    expect(loginRes.status).toBe(401);
  });

  test('invalid token returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'NewPass123!' });
    expect(res.status).toBe(400);
  });

  test('token cannot be reused after reset', async () => {
    const token = await requestResetToken(driver.email);
    await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token, newPassword: 'NewPass123!' });

    const res = await request(app)
      .post('/api/auth/driver/reset-password')
      .send({ token, newPassword: 'AnotherPass456!' });
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  // 12
  test('clears the token cookie and returns { ok: true }', async () => {
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const cookies = res.headers['set-cookie'] ?? [];
    const tokenCookie = cookies.find(c => c.startsWith('token='));
    // Cookie should be cleared (empty value or Max-Age=0 / Expires in the past)
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/token=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
});

// ─── 14 — Credential leak check (across all auth responses) ──────────────

describe('credentials are never present in any auth response body', () => {
  const SENSITIVE = ['app_password', 'san_password', 'password_hash'];

  test('driver registration response', async () => {
    const res = await request(app)
      .post('/api/auth/driver/register')
      .send(validRegBody);
    const body = JSON.stringify(res.body);
    SENSITIVE.forEach(field => expect(body).not.toContain(field));
  });

  test('driver login response', async () => {
    await request(app).post('/api/auth/driver/register').send(validRegBody);
    const res = await request(app)
      .post('/api/auth/driver/login')
      .send({ email: validRegBody.email, appPassword: validRegBody.appPassword });
    const body = JSON.stringify(res.body);
    SENSITIVE.forEach(field => expect(body).not.toContain(field));
  });

  test('admin login response', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.plainPassword });
    const body = JSON.stringify(res.body);
    SENSITIVE.forEach(field => expect(body).not.toContain(field));
  });
});
