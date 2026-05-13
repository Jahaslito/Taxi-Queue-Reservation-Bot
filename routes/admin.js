const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../database');
const { encrypt } = require('../crypto');
const { authenticateAdmin } = require('../middleware/auth');
const { runBotForDriver } = require('../scheduler');

// All admin routes require authentication
router.use(authenticateAdmin);

// ─── Stats overview ──────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  const totalDrivers   = db.prepare('SELECT COUNT(*) as c FROM drivers').get().c;
  const activeDrivers  = db.prepare('SELECT COUNT(*) as c FROM drivers WHERE is_active = 1').get().c;
  const todaySuccess   = db.prepare(`SELECT COUNT(*) as c FROM logs WHERE date(triggered_at) = ? AND status = 'success'`).get(today).c;
  const todayFailed    = db.prepare(`SELECT COUNT(*) as c FROM logs WHERE date(triggered_at) = ? AND status = 'failed'`).get(today).c;
  const todayTotal     = db.prepare(`SELECT COUNT(*) as c FROM logs WHERE date(triggered_at) = ?`).get(today).c;
  const allTimeSuccess = db.prepare(`SELECT COUNT(*) as c FROM logs WHERE status = 'success'`).get().c;
  const allTimeFailed  = db.prepare(`SELECT COUNT(*) as c FROM logs WHERE status = 'failed'`).get().c;

  // Scheduled times breakdown
  const scheduleBreakdown = db.prepare(`
    SELECT scheduled_time, COUNT(*) as count
    FROM drivers WHERE is_active = 1
    GROUP BY scheduled_time ORDER BY scheduled_time
  `).all();

  res.json({
    totalDrivers, activeDrivers,
    today: { success: todaySuccess, failed: todayFailed, total: todayTotal },
    allTime: { success: allTimeSuccess, failed: allTimeFailed },
    scheduleBreakdown
  });
});

// ─── List all drivers ────────────────────────────────────────────────────────
router.get('/drivers', (req, res) => {
  const search = req.query.search || '';
  const activeOnly = req.query.active === 'true';

  let query = `
    SELECT d.id, d.name, d.phone, d.email, d.san_username, d.vehicle_number,
           d.scheduled_time, d.is_active, d.notes, d.created_at,
           l.status as last_status, l.queue_position as last_position,
           l.triggered_at as last_run
    FROM drivers d
    LEFT JOIN logs l ON l.id = (
      SELECT id FROM logs WHERE driver_id = d.id ORDER BY triggered_at DESC LIMIT 1
    )
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ' AND (d.name LIKE ? OR d.vehicle_number LIKE ? OR d.san_username LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (activeOnly) {
    query += ' AND d.is_active = 1';
  }
  query += ' ORDER BY d.scheduled_time, d.name';

  const drivers = db.prepare(query).all(...params);
  res.json(drivers);
});

// ─── Get single driver ───────────────────────────────────────────────────────
router.get('/drivers/:id', (req, res) => {
  const driver = db.prepare(`
    SELECT id, name, phone, email, san_username, vehicle_number, scheduled_time, is_active, notes, created_at
    FROM drivers WHERE id = ?
  `).get(req.params.id);

  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const recentLogs = db.prepare(`
    SELECT * FROM logs WHERE driver_id = ? ORDER BY triggered_at DESC LIMIT 10
  `).all(req.params.id);

  res.json({ ...driver, recentLogs });
});

// ─── Add driver (admin-initiated) ────────────────────────────────────────────
router.post('/drivers', (req, res) => {
  try {
    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, notes } = req.body;

    if (!name || !sanUsername || !sanPassword || !vehicleNumber || !scheduledTime) {
      return res.status(400).json({ error: 'name, sanUsername, sanPassword, vehicleNumber, scheduledTime are required' });
    }

    // Admin-added drivers get a default app password = vehicle number
    const appPasswordHash = bcrypt.hashSync(vehicleNumber, 10);
    const encryptedSanPass = encrypt(sanPassword);

    const result = db.prepare(`
      INSERT INTO drivers (name, phone, email, app_password, san_username, san_password, vehicle_number, scheduled_time, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, phone || null, email || null, appPasswordHash, sanUsername, encryptedSanPass, vehicleNumber, scheduledTime, notes || null);

    const driver = db.prepare(`
      SELECT id, name, phone, email, san_username, vehicle_number, scheduled_time, is_active FROM drivers WHERE id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(driver);
  } catch (err) {
    console.error('[Admin] Add driver error:', err.message);
    res.status(500).json({ error: 'Failed to add driver' });
  }
});

// ─── Update driver ───────────────────────────────────────────────────────────
router.put('/drivers/:id', (req, res) => {
  try {
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, isActive, notes } = req.body;

    db.prepare(`
      UPDATE drivers SET
        name = ?, phone = ?, email = ?, san_username = ?,
        san_password = ?, vehicle_number = ?, scheduled_time = ?,
        is_active = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? driver.name,
      phone ?? driver.phone,
      email ?? driver.email,
      sanUsername ?? driver.san_username,
      sanPassword ? encrypt(sanPassword) : driver.san_password,
      vehicleNumber ?? driver.vehicle_number,
      scheduledTime ?? driver.scheduled_time,
      isActive !== undefined ? (isActive ? 1 : 0) : driver.is_active,
      notes ?? driver.notes,
      req.params.id
    );

    const updated = db.prepare(`
      SELECT id, name, phone, email, san_username, vehicle_number, scheduled_time, is_active, notes
      FROM drivers WHERE id = ?
    `).get(req.params.id);

    res.json(updated);
  } catch (err) {
    console.error('[Admin] Update driver error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Delete (deactivate) driver ──────────────────────────────────────────────
router.delete('/drivers/:id', (req, res) => {
  const driver = db.prepare('SELECT id FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  // Soft delete — just deactivate
  db.prepare("UPDATE drivers SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Driver deactivated' });
});

// ─── Manually trigger bot for a driver ───────────────────────────────────────
router.post('/drivers/:id/trigger', async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (!driver.is_active) return res.status(400).json({ error: 'Driver is inactive' });

  // Respond immediately, run in background
  res.json({ message: `Bot triggered for ${driver.name} (${driver.vehicle_number}). Check logs for result.` });

  runBotForDriver(driver, 'manual').catch(console.error);
});

// ─── Get all logs ────────────────────────────────────────────────────────────
router.get('/logs', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const driverId = req.query.driverId;
  const status   = req.query.status;
  const date     = req.query.date;   // YYYY-MM-DD
  const search   = req.query.search; // driver name or vehicle number

  let query = `
    SELECT l.*, d.name as driver_name, d.vehicle_number
    FROM logs l
    JOIN drivers d ON l.driver_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (driverId) { query += ' AND l.driver_id = ?'; params.push(driverId); }
  if (status)   { query += ' AND l.status = ?'; params.push(status); }
  if (date)     { query += ' AND date(l.triggered_at) = ?'; params.push(date); }
  if (search)   { query += ' AND (d.name LIKE ? OR d.vehicle_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  query += ' ORDER BY l.triggered_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const logs = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as c FROM logs`).get().c;

  res.json({ logs, total, limit, offset });
});

module.exports = router;
