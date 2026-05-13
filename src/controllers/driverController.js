const bcrypt        = require('bcryptjs');
const Driver        = require('../models/Driver');
const Log           = require('../models/Log');
const { encrypt }   = require('../services/cryptoService');

async function getProfile(req, res, next) {
  try {
    const driver = await Driver.findById(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }
    res.json(driver);
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    const { name, phone, scheduledTime, sanUsername, sanPassword, vehicleNumber, newAppPassword } = req.body;

    const updated = await Driver.update(req.driverId, {
      name:           name           || driver.name,
      phone:          phone          !== undefined ? phone : driver.phone,
      scheduled_time: scheduledTime  || driver.scheduled_time,
      san_username:   sanUsername    || driver.san_username,
      san_password:   sanPassword    ? encrypt(sanPassword)                  : driver.san_password,
      vehicle_number: vehicleNumber  || driver.vehicle_number,
      app_password:   newAppPassword ? await bcrypt.hash(newAppPassword, 10) : driver.app_password,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function getLogs(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [logs, countResult] = await Promise.all([
      Log.findByDriver(req.driverId, { limit, offset }),
      Log.countByDriver(req.driverId),
    ]);

    res.json({ logs, total: parseInt(countResult.count, 10), limit, offset });
  } catch (err) {
    next(err);
  }
}

async function getTodayStatus(req, res, next) {
  try {
    // Evaluate "today" in Pacific Time — consistent with the scheduler
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

    const [todayLog, driver] = await Promise.all([
      Log.findTodayLatest(req.driverId, today),
      Driver.findById(req.driverId),
    ]);

    res.json({ todayLog: todayLog || null, driver });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, getLogs, getTodayStatus };
