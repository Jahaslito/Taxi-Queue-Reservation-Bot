const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../database');
const { encrypt } = require('../crypto');
const { authenticateDriver } = require('../middleware/auth');

// ─── Get my profile ──────────────────────────────────────────────────────────
router.get('/profile', authenticateDriver, (req, res) => {
  const driver = db.prepare(`
    SELECT id, name, phone, email, san_username, vehicle_number, scheduled_time, is_active, notes, created_at
    FROM drivers WHERE id = ?
  `).get(req.driverId);

  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  res.json(driver);
});

// ─── Update profile / schedule ───────────────────────────────────────────────
router.put('/profile', authenticateDriver, (req, res) => {
  try {
    const { name, phone, scheduledTime, sanUsername, sanPassword, vehicleNumber, newAppPassword } = req.body;

    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) {
      return res.status(400).json({ error: 'scheduledTime must be HH:MM format' });
    }

    const updates = {
      name: name || driver.name,
      phone: phone !== undefined ? phone : driver.phone,
      scheduled_time: scheduledTime || driver.scheduled_time,
      san_username: sanUsername || driver.san_username,
      san_password: sanPassword ? encrypt(sanPassword) : driver.san_password,
      vehicle_number: vehicleNumber || driver.vehicle_number,
      app_password: newAppPassword ? bcrypt.hashSync(newAppPassword, 10) : driver.app_password,
      updated_at: new Date().toISOString()
    };

    db.prepare(`
      UPDATE drivers SET
        name = ?, phone = ?, scheduled_time = ?, san_username = ?,
        san_password = ?, vehicle_number = ?, app_password = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.name, updates.phone, updates.scheduled_time, updates.san_username,
      updates.san_password, updates.vehicle_number, updates.app_password, updates.updated_at,
      req.driverId
    );

    const updated = db.prepare(`
      SELECT id, name, phone, email, san_username, vehicle_number, scheduled_time, is_active
      FROM drivers WHERE id = ?
    `).get(req.driverId);

    res.json(updated);
  } catch (err) {
    console.error('[Profile] Update error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Get my recent logs ──────────────────────────────────────────────────────
router.get('/logs', authenticateDriver, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const logs = db.prepare(`
    SELECT * FROM logs
    WHERE driver_id = ?
    ORDER BY triggered_at DESC
    LIMIT ? OFFSET ?
  `).all(req.driverId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM logs WHERE driver_id = ?')
    .get(req.driverId).count;

  res.json({ logs, total, limit, offset });
});

// ─── Get today's status ──────────────────────────────────────────────────────
router.get('/status/today', authenticateDriver, (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  const log = db.prepare(`
    SELECT * FROM logs
    WHERE driver_id = ? AND date(triggered_at, 'localtime') = ?
    ORDER BY triggered_at DESC
    LIMIT 1
  `).get(req.driverId, today);

  const driver = db.prepare(`
    SELECT id, name, vehicle_number, scheduled_time, is_active FROM drivers WHERE id = ?
  `).get(req.driverId);

  res.json({ todayLog: log || null, driver });
});

module.exports = router;
