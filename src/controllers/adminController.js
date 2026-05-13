const bcrypt                  = require('bcryptjs');
const Driver                  = require('../models/Driver');
const Log                     = require('../models/Log');
const { encrypt }             = require('../services/cryptoService');
const { runBotForDriver }     = require('../services/schedulerService');

async function getStats(req, res, next) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

    const [
      totalDrivers,
      activeDrivers,
      todaySuccess,
      todayFailed,
      todayTotal,
      allTimeSuccess,
      allTimeFailed,
      scheduleBreakdown,
    ] = await Promise.all([
      Driver.count(),
      Driver.count({ activeOnly: true }),
      Log.countByStatusAndDate('success',        today),
      Log.countByStatusAndDate('failed',         today),
      Log.countByDate(today),
      Log.countAllByStatus('success'),
      Log.countAllByStatus('failed'),
      Driver.scheduleBreakdown(),
    ]);

    res.json({
      totalDrivers:  parseInt(totalDrivers.count,  10),
      activeDrivers: parseInt(activeDrivers.count, 10),
      today: {
        success: parseInt(todaySuccess.count, 10),
        failed:  parseInt(todayFailed.count,  10),
        total:   parseInt(todayTotal.count,   10),
      },
      allTime: {
        success: parseInt(allTimeSuccess.count, 10),
        failed:  parseInt(allTimeFailed.count,  10),
      },
      scheduleBreakdown,
    });
  } catch (err) {
    next(err);
  }
}

async function listDrivers(req, res, next) {
  try {
    const { search, active } = req.query;
    const drivers = await Driver.search({ search, activeOnly: active === 'true' });
    res.json(drivers);
  } catch (err) {
    next(err);
  }
}

async function getDriver(req, res, next) {
  try {
    const [driver, recentLogs] = await Promise.all([
      Driver.findById(req.params.id),
      Log.findByDriver(req.params.id, { limit: 10 }),
    ]);

    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    res.json({ ...driver, recentLogs });
  } catch (err) {
    next(err);
  }
}

async function addDriver(req, res, next) {
  try {
    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, notes } = req.body;

    // Admin-added drivers get vehicle number as default app password
    const driver = await Driver.create({
      name,
      phone:          phone  || null,
      email:          email  || null,
      app_password:   await bcrypt.hash(vehicleNumber, 10),
      san_username:   sanUsername,
      san_password:   encrypt(sanPassword),
      vehicle_number: vehicleNumber,
      scheduled_time: scheduledTime,
      notes:          notes  || null,
    });

    res.status(201).json(driver);
  } catch (err) {
    next(err);
  }
}

async function updateDriver(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.params.id);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, isActive, notes } = req.body;

    const updated = await Driver.update(req.params.id, {
      name:           name           ?? driver.name,
      phone:          phone          ?? driver.phone,
      email:          email          ?? driver.email,
      san_username:   sanUsername    ?? driver.san_username,
      san_password:   sanPassword    ? encrypt(sanPassword) : driver.san_password,
      vehicle_number: vehicleNumber  ?? driver.vehicle_number,
      scheduled_time: scheduledTime  ?? driver.scheduled_time,
      is_active:      isActive       !== undefined ? isActive : driver.is_active,
      notes:          notes          ?? driver.notes,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deactivateDriver(req, res, next) {
  try {
    const driver = await Driver.findById(req.params.id);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    await Driver.deactivate(req.params.id);
    res.json({ message: 'Driver deactivated' });
  } catch (err) {
    next(err);
  }
}

async function triggerDriver(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.params.id);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }
    if (!driver.is_active) {
      const err = new Error('Driver is inactive');
      err.statusCode = 400;
      throw err;
    }

    // Respond immediately — the bot runs in the background
    res.json({ message: `Bot triggered for ${driver.name} (${driver.vehicle_number}). Check logs for result.` });
    runBotForDriver(driver, 'manual').catch(console.error);
  } catch (err) {
    next(err);
  }
}

async function getLogs(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const filters = {
      driverId: req.query.driverId,
      status:   req.query.status,
      date:     req.query.date,
      search:   req.query.search,
    };

    const [logs, countResult] = await Promise.all([
      Log.search({ ...filters, limit, offset }),
      Log.count(filters),
    ]);

    res.json({ logs, total: parseInt(countResult.count, 10), limit, offset });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStats,
  listDrivers,
  getDriver,
  addDriver,
  updateDriver,
  deactivateDriver,
  triggerDriver,
  getLogs,
};
