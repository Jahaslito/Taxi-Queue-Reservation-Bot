const bcrypt            = require('bcryptjs');
const Driver            = require('../models/Driver');
const Admin             = require('../models/Admin');
const { encrypt }       = require('../services/cryptoService');
const { generateToken } = require('../middleware/auth');
const { nodeEnv }       = require('../config/env');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   nodeEnv === 'production',
};

async function registerDriver(req, res, next) {
  try {
    const { name, phone, email, appPassword, sanUsername, sanPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules } = req.body;

    if (email) {
      const existing = await Driver.findByEmail(email);
      if (existing) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }
    }

    // Build day_schedules JSON
    let daySchedulesJson;
    if (daySchedules) {
      daySchedulesJson = daySchedules; // already a JSON string from frontend
    } else {
      const activeDays = (scheduledDays || '0,1,2,3,4,5,6').split(',').map(String);
      const ds = {};
      for (let d = 0; d < 7; d++) {
        ds[String(d)] = activeDays.includes(String(d)) ? (scheduledTime || '05:00') : null;
      }
      daySchedulesJson = JSON.stringify(ds);
    }

    const driver = await Driver.create({
      name,
      phone:          phone        || null,
      email:          email        || null,
      app_password:   await bcrypt.hash(appPassword, 10),
      san_username:   sanUsername,
      san_password:   encrypt(sanPassword),
      vehicle_number: vehicleNumber,
      scheduled_time: scheduledTime,
      scheduled_days: scheduledDays || '0,1,2,3,4,5,6',
      day_schedules:  daySchedulesJson,
    });

    const token = generateToken(driver.id, 'driver');
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.status(201).json({ driver });
  } catch (err) {
    next(err);
  }
}

async function loginDriver(req, res, next) {
  try {
    const { email, vehicleNumber, appPassword } = req.body;

    const record = email
      ? await Driver.findByEmail(email)
      : await Driver.findByVehicleNumber(vehicleNumber);

    // Fetch full record (with hashed password) only after we know the driver exists
    const driver = record ? await Driver.findByIdWithCredentials(record.id) : null;

    const passwordMatch = driver && await bcrypt.compare(appPassword, driver.app_password);
    if (!driver || !passwordMatch) {
      const err = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    const token = generateToken(driver.id, 'driver');
    const { app_password, san_password, ...safeDriver } = driver;
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ driver: safeDriver });
  } catch (err) {
    next(err);
  }
}

async function loginAdmin(req, res, next) {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findByUsername(username);
    const passwordMatch = admin && await bcrypt.compare(password, admin.password_hash);

    if (!admin || !passwordMatch) {
      const err = new Error('Invalid admin credentials');
      err.statusCode = 401;
      throw err;
    }

    const token = generateToken(admin.id, 'admin', '7d');
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    next(err);
  }
}

async function resetDriverPassword(req, res, next) {
  try {
    const { email } = req.body;
    const driver = await Driver.findByEmail(email);

    // Always respond the same way — don't reveal whether the email exists
    if (!driver) {
      return res.json({ message: 'If that email is registered, the password has been reset.' });
    }

    const full = await Driver.findByIdWithCredentials(driver.id);
    await Driver.update(driver.id, {
      name:           full.name,
      phone:          full.phone,
      email:          full.email,
      app_password:   await bcrypt.hash(full.vehicle_number, 10),
      san_username:   full.san_username,
      san_password:   full.san_password,
      vehicle_number: full.vehicle_number,
      scheduled_time: full.scheduled_time,
      is_active:      full.is_active,
      notes:          full.notes,
    });

    res.json({ message: 'If that email is registered, the password has been reset.' });
  } catch (err) {
    next(err);
  }
}

function logout(req, res) {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: nodeEnv === 'production' });
  res.json({ ok: true });
}

module.exports = { registerDriver, loginDriver, loginAdmin, logout, resetDriverPassword };
