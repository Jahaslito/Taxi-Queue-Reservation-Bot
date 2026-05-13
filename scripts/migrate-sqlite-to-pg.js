/**
 * One-time data migration: SQLite → PostgreSQL
 *
 * Reads all rows from the old data/queue.db and inserts them into
 * the PostgreSQL database, preserving original IDs so foreign key
 * relationships stay intact. Safe to run multiple times — conflicts
 * are ignored so existing rows are never overwritten.
 *
 * Usage: node scripts/migrate-sqlite-to-pg.js
 */

require('dotenv').config();

const SQLiteDB = require('better-sqlite3');
const path     = require('path');
const db       = require('../src/config/database');

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'queue.db');

async function migrate() {
  console.log('Opening SQLite database:', SQLITE_PATH);
  const sqlite = new SQLiteDB(SQLITE_PATH, { readonly: true });

  const admins  = sqlite.prepare('SELECT * FROM admin_users').all();
  const drivers = sqlite.prepare('SELECT * FROM drivers').all();
  const logs    = sqlite.prepare('SELECT * FROM logs').all();

  console.log(`\nFound in SQLite:`);
  console.log(`  admin_users : ${admins.length}`);
  console.log(`  drivers     : ${drivers.length}`);
  console.log(`  logs        : ${logs.length}\n`);

  // ── admin_users ────────────────────────────────────────────────────────────
  if (admins.length) {
    for (const row of admins) {
      await db('admin_users')
        .insert({
          id:            row.id,
          username:      row.username,
          password_hash: row.password_hash,
          created_at:    new Date(row.created_at),
          updated_at:    new Date(row.updated_at || row.created_at),
        })
        .onConflict('username')
        .ignore(); // keep the existing PG admin if username already exists
    }

    // Advance the sequence so future inserts don't collide with migrated IDs
    await db.raw(`SELECT setval('admin_users_id_seq', (SELECT MAX(id) FROM admin_users))`);
    console.log(`✓ admin_users  — ${admins.length} row(s) processed`);
  }

  // ── drivers ────────────────────────────────────────────────────────────────
  if (drivers.length) {
    for (const row of drivers) {
      await db('drivers')
        .insert({
          id:             row.id,
          name:           row.name,
          phone:          row.phone           || null,
          email:          row.email           || null,
          app_password:   row.app_password,
          san_username:   row.san_username,
          san_password:   row.san_password,   // already AES-256-CBC encrypted
          vehicle_number: row.vehicle_number,
          scheduled_time: row.scheduled_time,
          is_active:      row.is_active === 1, // SQLite 0/1 → PostgreSQL boolean
          notes:          row.notes           || null,
          created_at:     new Date(row.created_at),
          updated_at:     new Date(row.updated_at || row.created_at),
        })
        .onConflict('id')
        .ignore();
    }

    await db.raw(`SELECT setval('drivers_id_seq', (SELECT MAX(id) FROM drivers))`);
    console.log(`✓ drivers      — ${drivers.length} row(s) processed`);
  }

  // ── logs ───────────────────────────────────────────────────────────────────
  if (logs.length) {
    for (const row of logs) {
      await db('logs')
        .insert({
          id:             row.id,
          driver_id:      row.driver_id,
          triggered_at:   new Date(row.triggered_at),
          trigger_type:   row.trigger_type,
          status:         row.status,
          queue_position: row.queue_position  || null,
          queue_location: row.queue_location  || null,
          queue_time:     row.queue_time      || null,
          error_message:  row.error_message   || null,
          duration_ms:    row.duration_ms     || null,
          created_at:     new Date(row.created_at || row.triggered_at),
        })
        .onConflict('id')
        .ignore();
    }

    await db.raw(`SELECT setval('logs_id_seq', (SELECT MAX(id) FROM logs))`);
    console.log(`✓ logs         — ${logs.length} row(s) processed`);
  }

  sqlite.close();
  await db.destroy();

  console.log('\n✅  Migration complete. PostgreSQL is now in sync with the old SQLite data.');
}

migrate().catch((err) => {
  console.error('\n❌  Migration failed:', err.message);
  process.exit(1);
});
