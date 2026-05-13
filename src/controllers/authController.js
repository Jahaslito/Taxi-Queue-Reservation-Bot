const bcrypt          = require('bcryptjs');
const Driver          = require('../models/Driver');
const Admin           = require('../models/Admin');
const { encrypt }     = require('../services/cryptoService');
const { generateToken } = require('../middleware/auth');

async function registerDriver(req, res, next) {
  try {
    const { name, phone, email, appPassword, sanUsername, sanPassword, vehicleNumber, scheduledTime } = req.body;

    if (email) {
      const existing = await Driver.findByEmail(email);
      if (existing) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }
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
    });

    const token = generateToken(driver.id, 'driver');
    res.status(201).json({ token, driver });
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
    res.json({ token, driver: safeDriver });
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
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    next(err);
  }
}

module.exports = { registerDriver, loginDriver, loginAdmin };
