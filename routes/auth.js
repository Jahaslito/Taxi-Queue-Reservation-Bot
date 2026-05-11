const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../database');
const { encrypt } = require('../crypto');
const { generateToken } = require('../middleware/auth');

// ─── Driver: Register ────────────────────────────────────────────────────────
router.post('/driver/register', async (req, res) => {
  try {
    const { name, phone, email, appPassword, sanUsername, sanPassword, vehicleNumber, scheduledTime } = req.body;

    if (!name || !appPassword || !sanUsername || !sanPassword || !vehicleNumber || !scheduledTime) {
      return res.status(400).json({ error: 'All required fields must be provided' });
    }

    // Validate time format HH:MM
    if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
      return res.status(400).json({ error: 'scheduledTime must be in HH:MM format' });
    }

    // Check email uniqueness if provided
    if (email) {
      const existing = db.prepare('SELECT id FROM drivers WHERE email = ?').get(email);
      if (existing) return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = bcrypt.hashSync(appPassword, 10);
    const encryptedSanPassword = encrypt(sanPassword);

    const result = db.prepare(`
      INSERT INTO drivers (name, phone, email, app_password, san_username, san_password, vehicle_number, scheduled_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, phone || null, email || null, passwordHash, sanUsername, encryptedSanPassword, vehicleNumber, scheduledTime);

    const driver = db.prepare('SELECT id, name, email, vehicle_number, scheduled_time, is_active, created_at FROM drivers WHERE id = ?')
      .get(result.lastInsertRowid);

    const token = generateToken(driver.id, 'driver');
    res.status(201).json({ token, driver });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Driver: Login ───────────────────────────────────────────────────────────
router.post('/driver/login', (req, res) => {
  try {
    const { email, vehicleNumber, appPassword } = req.body;

    if ((!email && !vehicleNumber) || !appPassword) {
      return res.status(400).json({ error: 'Provide email or vehicle number and password' });
    }

    let driver;
    if (email) {
      driver = db.prepare('SELECT * FROM drivers WHERE email = ?').get(email);
    } else {
      driver = db.prepare('SELECT * FROM drivers WHERE vehicle_number = ?').get(vehicleNumber);
    }

    if (!driver || !bcrypt.compareSync(appPassword, driver.app_password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(driver.id, 'driver');
    const { app_password, san_password, ...safeDriver } = driver;
    res.json({ token, driver: safeDriver });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Admin: Login ────────────────────────────────────────────────────────────
router.post('/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const token = generateToken(admin.id, 'admin', '7d');
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error('[Auth] Admin login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
