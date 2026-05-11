const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'queue.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone       TEXT,
    email       TEXT    UNIQUE,
    app_password TEXT   NOT NULL,
    san_username TEXT   NOT NULL,
    san_password TEXT   NOT NULL,
    vehicle_number TEXT NOT NULL,
    scheduled_time TEXT NOT NULL DEFAULT '05:00',
    is_active   INTEGER NOT NULL DEFAULT 1,
    notes       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id     INTEGER NOT NULL,
    triggered_at  DATETIME NOT NULL,
    trigger_type  TEXT NOT NULL DEFAULT 'scheduled',
    status        TEXT NOT NULL DEFAULT 'pending',
    queue_position INTEGER,
    queue_location TEXT,
    queue_time    TEXT,
    error_message TEXT,
    duration_ms   INTEGER,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_logs_driver_id ON logs(driver_id);
  CREATE INDEX IF NOT EXISTS idx_logs_triggered_at ON logs(triggered_at);
  CREATE INDEX IF NOT EXISTS idx_drivers_scheduled_time ON drivers(scheduled_time);
`);

// Seed default admin if none exists
const adminExists = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
if (!adminExists) {
  const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run('admin', hash);
  console.log(`[DB] Default admin created. Username: admin, Password: ${defaultPassword}`);
  console.log('[DB] ⚠️  Change ADMIN_PASSWORD in your .env file!');
}

module.exports = db;
