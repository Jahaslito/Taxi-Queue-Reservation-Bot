/**
 * Rate-limit tests — kept in a separate file so they get a fresh module
 * registry (and therefore a fresh in-memory rate-limiter instance).
 * Other test files would otherwise consume the request budget.
 *
 * Run independently: npx jest tests/api/rateLimit.test.js
 */
const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll }                          = require('../helpers/db');
const { createAdmin, createDriver, adminCookie, driverCookie } = require('../helpers/fixtures');

const app = createApp();

beforeAll(async () => {
  await migrateUp();
  // Re-enable rate limiting for this file only — all other test files skip it
  process.env.SKIP_RATE_LIMIT = 'false';
});

afterAll(() => {
  delete process.env.SKIP_RATE_LIMIT;
});

afterEach(async () => {
  await truncateAll();
});

// ─── 13 — Auth rate limiter (10 req / 15 min) ────────────────────────────

describe('auth rate limiter', () => {
  test('returns 429 after 10 failed login attempts within the window', async () => {
    const statuses = [];

    // Make 11 sequential requests — first 10 should be 401, 11th should be 429
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/auth/driver/login')
        .send({ vehicleNumber: 'DOESNOTEXIST', appPassword: 'wrong' });
      statuses.push(res.status);
    }

    // At least one response must be 429
    expect(statuses).toContain(429);
    // The final response should definitely be 429
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});

// ─── 24 — API rate limiter (120 req / min) ───────────────────────────────

describe('API rate limiter', () => {
  test('X-RateLimit-Limit header is set on admin routes confirming limiter is wired', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Cookie', adminCookie(admin.id));

    expect(res.status).toBe(200);
    // express-rate-limit sets this header when standardHeaders: true
    expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeDefined();
  });

  test('X-RateLimit-Limit header is set on driver routes confirming limiter is wired', async () => {
    const driver = await createDriver();

    const res = await request(app)
      .get('/api/driver/profile')
      .set('Cookie', driverCookie(driver.id));

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
