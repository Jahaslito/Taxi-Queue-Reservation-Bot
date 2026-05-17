/**
 * Test data factories and JWT cookie helpers.
 *
 * Every factory returns the inserted row plus any plain-text secrets it
 * generated, so tests can use them in subsequent login/auth calls.
 */
const bcrypt           = require('bcryptjs');
const { db }           = require('./db');
const { encrypt }      = require('../../src/services/cryptoService');
const { generateToken } = require('../../src/middleware/auth');

// ─── Default credentials ───────────────────────────────────────────────────

const DEFAULT_DRIVER_PASSWORD = 'driverpass123';
const DEFAULT_ADMIN_PASSWORD  = 'adminpass123';

// ─── Unique-ID counter ────────────────────────────────────────────────────
// Using a simple counter avoids Date.now() collisions when createDriver /
// createAdmin are called multiple times within the same millisecond
// (e.g. inside Promise.all or rapid test.each iterations).
let _seq = 0;
function uid() { return `${Date.now()}_${++_seq}`; }

// ─── Factories ────────────────────────────────────────────────────────────

/**
 * Insert an admin_users row and return it with the plain password attached.
 */
async function createAdmin({ username, password = DEFAULT_ADMIN_PASSWORD } = {}) {
  const resolvedUsername = username ?? `admin_${uid()}`;
  const [admin] = await db('admin_users')
    .insert({ username: resolvedUsername, password_hash: await bcrypt.hash(password, 10) })
    .returning(['id', 'username']);
  return { ...admin, plainPassword: password };
}

/**
 * Insert a drivers row and return the full row with the plain password attached.
 *
 * All fields have sensible defaults; pass overrides to customise.
 * Use `plainPassword` override to control the password if you need to log
 * in as this driver in the same test.
 *
 * NOTE: `vehicle_number` is given a timestamp suffix to stay unique across
 * tests even when RESTART IDENTITY resets sequences (the unique constraint is
 * on vehicle_number, not the PK).
 */
async function createDriver(overrides = {}) {
  const plainPassword = overrides.plainPassword || DEFAULT_DRIVER_PASSWORD;
  const vehicleNumber = overrides.vehicle_number || `VH${uid()}`;
  const email         = overrides.email          || `driver_${uid()}@test.com`;

  const defaults = {
    name:           'Test Driver',
    email,
    app_password:   await bcrypt.hash(plainPassword, 10),
    san_username:   'test_san_user',
    san_password:   encrypt('test_san_password'),
    vehicle_number: vehicleNumber,
    scheduled_time: '05:00',
    scheduled_days: '0,1,2,3,4,5,6',
    day_schedules:  JSON.stringify({
      '0': '05:00', '1': '05:00', '2': '05:00',
      '3': '05:00', '4': '05:00', '5': '05:00', '6': '05:00',
    }),
    is_active:      true,
  };

  // Strip helper keys that are not real columns before inserting
  const { plainPassword: _pw, ...columnOverrides } = overrides;
  const data = { ...defaults, ...columnOverrides };

  const [driver] = await db('drivers').insert(data).returning('*');
  return { ...driver, plainPassword };
}

// ─── Cookie helpers ────────────────────────────────────────────────────────

/**
 * Return a `Cookie` header string carrying a signed admin JWT.
 * Pass directly to supertest: `.set('Cookie', adminCookie(admin.id))`
 */
function adminCookie(adminId) {
  return `token=${generateToken(adminId, 'admin', '1h')}`;
}

/**
 * Return a `Cookie` header string carrying a signed driver JWT.
 * Pass directly to supertest: `.set('Cookie', driverCookie(driver.id))`
 */
function driverCookie(driverId) {
  return `token=${generateToken(driverId, 'driver', '1h')}`;
}

// ─── Shared valid-registration body ───────────────────────────────────────

/**
 * A complete, valid driver-registration payload.
 * Spread and override individual fields in tests.
 */
const validRegBody = {
  name:          'Jane Driver',
  appPassword:   'securepassword',
  sanUsername:   'jane_san',
  sanPassword:   'jane_san_pass',
  vehicleNumber: 'JD001',
  scheduledTime: '06:00',
  email:         'jane@example.com',
};

module.exports = {
  createAdmin,
  createDriver,
  adminCookie,
  driverCookie,
  validRegBody,
  DEFAULT_DRIVER_PASSWORD,
  DEFAULT_ADMIN_PASSWORD,
};
