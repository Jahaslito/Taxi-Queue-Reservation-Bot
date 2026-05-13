require('dotenv').config();

// Validates all required env vars before anything else loads.
// Server exits immediately with a clear message if any are missing.
const env = require('./src/config/env');

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const path         = require('path');

const errorHandler = require('./src/middleware/errorHandler');

const app = express();

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: env.allowedOrigin }));

// ─── Body parsing + static files ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',   require('./src/routes/auth'));
app.use('/api/driver', require('./src/routes/driver'));
app.use('/api/admin',  require('./src/routes/admin'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ─── SPA fallbacks ────────────────────────────────────────────────────────────
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Centralised error handler (must be last) ─────────────────────────────────
app.use(errorHandler);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
  const db    = require('./src/config/database');
  const Admin = require('./src/models/Admin');
  const bcrypt = require('bcryptjs');

  // Run any pending migrations before accepting traffic
  await db.migrate.latest();
  console.log('[DB] Migrations up to date');

  // Seed the default admin account on first run
  const adminExists = await Admin.exists();
  if (!adminExists) {
    const hash = await bcrypt.hash(env.adminPassword, 10);
    await Admin.create({ username: 'admin', password_hash: hash });
    console.log(`[DB] Default admin created — username: admin`);
    console.log('[DB] ⚠️  Set ADMIN_PASSWORD in your .env before going to production!');
  }

  app.listen(env.port, () => {
    console.log(`\n🚕  SAN Queue Scheduler running on port ${env.port}`);
    console.log(`    Driver App : http://localhost:${env.port}`);
    console.log(`    Admin      : http://localhost:${env.port}/admin\n`);

    const { startScheduler } = require('./src/services/schedulerService');
    startScheduler();
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal] Failed to start server:', err.message);
  process.exit(1);
});

module.exports = app;
