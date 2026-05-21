require('dotenv').config();

// Validates all required env vars before anything else loads.
// Server exits immediately with a clear message if any are missing.
const env = require('./src/config/env');

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');

const errorHandler = require('./src/middleware/errorHandler');

const app = express();

// ─── Trust reverse-proxy headers ─────────────────────────────────────────────
// Needed in production (Railway) and when tunnelling locally (ngrok/localtunnel).
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  // Enable HSTS in production (Railway serves via HTTPS at the edge).
  // Keep it off in dev/test so plain HTTP still works locally.
  hsts: env.nodeEnv === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({
  origin:      env.allowedOrigin,
  credentials: true,
}));

// ─── Body parsing + static files ──────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Bot debug screenshots (admin only — local dev) ───────────────────────────
const DEBUG_DIR = process.env.BOT_DEBUG_DIR ?? '/tmp/san-bot-debug';
const fs = require('fs');
app.get('/admin/bot-debug', (req, res) => {
  const files = fs.readdirSync(DEBUG_DIR).filter(f => f.endsWith('.png')).sort().reverse();
  const items = files.map(f =>
    `<div style="margin-bottom:32px">
       <div style="font-family:monospace;font-size:12px;color:#aaa;margin-bottom:6px;">${f}</div>
       <img src="/admin/bot-debug/${f}" style="max-width:390px;border:1px solid #333;border-radius:8px;">
     </div>`
  ).join('');
  res.send(`<!DOCTYPE html><html><body style="background:#111;padding:24px;color:#fff;font-family:sans-serif">
    <h2>Bot Debug Screenshots</h2><p style="color:#aaa">${files.length} screenshot(s) — newest first</p>
    <a href="javascript:location.reload()" style="color:#4af;font-size:13px;">↻ Refresh</a>
    <div style="margin-top:24px">${items}</div>
  </body></html>`);
});
app.use('/admin/bot-debug', express.static(DEBUG_DIR));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',         require('./src/routes/auth'));
app.use('/api/driver',      require('./src/routes/driver'));
app.use('/api/admin',       require('./src/routes/admin'));
app.use('/api/admin/monitor',   require('./src/routes/monitor'));
app.use('/api/admin/watchlist', require('./src/routes/watchlist'));

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
    await Admin.create({ username: env.adminUsername, password_hash: hash });
    console.log(`[DB] Default admin created — username: ${env.adminUsername}`);
    console.log('[DB] ⚠️  Set ADMIN_USERNAME and ADMIN_PASSWORD in your .env before going to production!');
  }

  global._httpServer = app.listen(env.port, () => {
    console.log(`\n🚕  SAN Queue Scheduler running on port ${env.port}`);
    console.log(`    Driver App : http://localhost:${env.port}`);
    console.log(`    Admin      : http://localhost:${env.port}/admin\n`);

    const { startScheduler } = require('./src/services/schedulerService');
    startScheduler();

    const { startMonitor } = require('./src/services/monitorService');
    startMonitor().catch((err) => console.error('[Monitor] Failed to start:', err.message));
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal] Failed to start server:', err.message);
  process.exit(1);
});

// ─── Process-level crash guards ───────────────────────────────────────────────
// Catch anything that slips past Express / async handlers.
// Log the full stack, then exit so Railway/Docker restarts the container cleanly.
// (Staying alive after an uncaughtException is unsafe — the process may be in a
//  corrupt state. A clean restart is always the safer option.)

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception — restarting:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled promise rejection — restarting:', reason);
  process.exit(1);
});

// ─── Graceful shutdown (SIGTERM from Railway / Docker stop) ───────────────────
// Railway sends SIGTERM before force-killing. Give in-flight requests up to 10s
// to finish before the process exits, so active SSE clients and bot jobs aren't
// cut off mid-run.
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received — closing server gracefully…');
  // server is module-scoped via app.listen return value; re-use the reference
  // by attaching it at listen time.
  if (global._httpServer) {
    global._httpServer.close(() => {
      console.log('[Shutdown] All connections closed — exiting.');
      process.exit(0);
    });
    // Force-exit after 10s in case some connections are stuck
    setTimeout(() => {
      console.warn('[Shutdown] Timeout — force exiting.');
      process.exit(0);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
});

module.exports = app;
