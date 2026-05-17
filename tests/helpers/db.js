/**
 * Shared Knex instance used by every test file.
 *
 * Design notes
 * ────────────
 * • `migrateUp()` is idempotent — safe to call in each file's `beforeAll`.
 * • `truncateAll()` clears data between tests without touching schema.
 * • We intentionally do NOT call `db.destroy()` here; `forceExit: true` in
 *   jest.config.js handles pool teardown, which avoids double-destroy errors
 *   when multiple files run in the same process.
 */
const knex = require('knex');
const path = require('path');

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: path.join(__dirname, '../../src/migrations'),
    tableName: 'knex_migrations',
  },
  pool: { min: 1, max: 5 },
});

/** Run all pending migrations. Safe to call multiple times (idempotent). */
async function migrateUp() {
  await db.migrate.latest();
}

/** Roll back every migration — use only when you want a full schema teardown. */
async function migrateDown() {
  await db.migrate.rollback(undefined, true);
}

/**
 * Truncate all app tables and reset serial sequences.
 * Call in `afterEach` to give every test a clean slate.
 */
async function truncateAll() {
  // logs must come before drivers because of the FK constraint
  await db.raw('TRUNCATE TABLE logs, drivers, admin_users RESTART IDENTITY CASCADE');
}

module.exports = { db, migrateUp, migrateDown, truncateAll };
