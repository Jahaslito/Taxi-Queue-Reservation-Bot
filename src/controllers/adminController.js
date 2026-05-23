const bcrypt                  = require('bcryptjs');
const crypto                  = require('crypto');
const db                      = require('../config/database');
const Driver                  = require('../models/Driver');
const Log                     = require('../models/Log');
const PositionClaim           = require('../models/PositionClaim');
const { encrypt }             = require('../services/cryptoService');
const { runBotForDriver }     = require('../services/schedulerService');
const { sendVerificationEmail } = require('../services/emailService');

async function getStats(req, res, next) {
  try {
    const now   = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

    // Day-of-week index (0=Sun … 6=Sat) in Pacific Time
    const dayAbbr  = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
    const DAY_MAP  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const todayDay = String(DAY_MAP[dayAbbr]);

    const [
      totalDrivers,
      activeDrivers,
      todaySuccess,
      todayFailed,
      todayTotal,
      allTimeSuccess,
      allTimeFailed,
      allActiveDrivers,
    ] = await Promise.all([
      Driver.count(),
      Driver.count({ activeOnly: true }),
      Log.countByStatusAndDate('success', today),
      Log.countByStatusAndDate('failed',  today),
      Log.countByDate(today),
      Log.countAllByStatus('success'),
      Log.countAllByStatus('failed'),
      Driver.findAllActive(),          // replaces scheduleBreakdown()
    ]);

    // Build a day-aware breakdown, separating time-scheduled and position-scheduled drivers
    const timeGroups       = {};
    const positionDrivers  = [];

    for (const driver of allActiveDrivers) {
      // Position-scheduled — collect separately, never appear in time breakdown
      if (driver.day_positions) {
        let targetPosition = null;
        try {
          const dp = JSON.parse(driver.day_positions);
          targetPosition = dp[todayDay] ?? null;
        } catch {}
        if (targetPosition !== null) {
          positionDrivers.push({
            name:            driver.name,
            vehicle_number:  driver.vehicle_number,
            target_position: targetPosition,
          });
        }
        continue;
      }

      // Time-scheduled
      let timeForToday = null;
      if (driver.day_schedules) {
        try {
          const ds = JSON.parse(driver.day_schedules);
          timeForToday = ds[todayDay] || null;
        } catch {}
      } else {
        const activeDays = (driver.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
        if (activeDays.includes(todayDay)) timeForToday = driver.scheduled_time;
      }

      if (!timeForToday) continue;
      timeGroups[timeForToday] = (timeGroups[timeForToday] || 0) + 1;
    }

    positionDrivers.sort((a, b) => a.vehicle_number.localeCompare(b.vehicle_number));

    const scheduleBreakdown = Object.keys(timeGroups)
      .sort()
      .map(time => ({ scheduled_time: time, count: timeGroups[time] }));

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
      positionDrivers,
    });
  } catch (err) {
    next(err);
  }
}

async function listDrivers(req, res, next) {
  try {
    const { search, active } = req.query;
    const limit  = Math.min(parseInt(req.query.limit,  10) || 25, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const filters = { search, activeOnly: active === 'true' };

    const [drivers, countResult] = await Promise.all([
      Driver.search({ ...filters, limit, offset }),
      Driver.searchCount(filters),
    ]);

    res.json({ drivers, total: parseInt(countResult.count, 10), limit, offset });
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
    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules, notes } = req.body;

    // Build day_schedules JSON
    let daySchedulesJson;
    if (daySchedules) {
      daySchedulesJson = daySchedules;
    } else {
      const activeDays = (scheduledDays || '0,1,2,3,4,5,6').split(',').map(String);
      const ds = {};
      for (let d = 0; d < 7; d++) {
        ds[String(d)] = activeDays.includes(String(d)) ? (scheduledTime || '05:00') : null;
      }
      daySchedulesJson = JSON.stringify(ds);
    }

    // Generate a secure random temporary password the admin can share with the driver
    const tempPassword = crypto.randomBytes(6).toString('base64url'); // 8-char URL-safe string

    const driver = await Driver.create({
      name,
      phone:          phone  || null,
      email:          email  || null,
      app_password:   await bcrypt.hash(tempPassword, 10),
      san_username:   sanUsername,
      san_password:   encrypt(sanPassword),
      vehicle_number: vehicleNumber,
      scheduled_time: scheduledTime,
      scheduled_days: scheduledDays || '0,1,2,3,4,5,6',
      day_schedules:  daySchedulesJson,
      notes:          notes  || null,
    });

    // Send verification email if driver has an email address
    if (email) {
      const verificationToken   = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await Driver.update(driver.id, {
        email_verification_token:      verificationToken,
        email_verification_expires_at: verificationExpires,
      });
      sendVerificationEmail({ ...driver, email }, verificationToken).catch((err) =>
        console.error('[Email] Failed to send admin-created driver verification email:', err.message),
      );
    }

    // Return tempPassword once so the admin can hand it to the driver — never stored in plain text
    res.status(201).json({ ...driver, tempPassword });
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

    const { name, phone, email, sanUsername, sanPassword, appPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules, scheduledPosition, dayPositions, isActive, notes } = req.body;

    // One-at-a-time: position-based and time-based scheduling are mutually exclusive.
    let derivedScheduledTime     = scheduledTime ?? driver.scheduled_time;
    let derivedScheduledDays     = scheduledDays    !== undefined ? scheduledDays    : driver.scheduled_days;
    let derivedDaySchedules      = daySchedules     !== undefined ? daySchedules     : driver.day_schedules;
    let derivedScheduledPosition = scheduledPosition !== undefined ? (scheduledPosition || null) : driver.scheduled_position;
    let derivedDayPositions      = dayPositions     !== undefined ? dayPositions     : driver.day_positions;

    if (dayPositions !== undefined && dayPositions) {
      // Per-day position mode — clear all time-based and single-position fields
      derivedScheduledTime     = null;
      derivedScheduledDays     = null;
      derivedDaySchedules      = null;
      derivedScheduledPosition = null;
    } else if (scheduledPosition !== undefined && scheduledPosition) {
      // Single position mode — clear time-based and day_positions fields
      derivedScheduledTime     = null;
      derivedScheduledDays     = null;
      derivedDaySchedules      = null;
      derivedDayPositions      = null;
    } else if (daySchedules !== undefined || scheduledTime !== undefined) {
      // Switching to time-based — wipe all position fields
      derivedScheduledPosition = null;
      derivedDayPositions      = null;
      if (daySchedules !== undefined) {
        try {
          const ds         = JSON.parse(daySchedules);
          const activeDays = Object.keys(ds).filter(k => ds[k] !== null);
          const times      = activeDays.map(k => ds[k]).filter(Boolean);
          derivedScheduledTime = times[0] || driver.scheduled_time || '05:00';
          derivedScheduledDays = activeDays.join(',') || driver.scheduled_days || '0,1,2,3,4,5,6';
        } catch { /* keep existing values */ }
      }
    }

    // Normalise email: treat empty string the same as "not provided"
    const normalisedEmail = (email !== undefined) ? (email.trim() || null) : driver.email;

    const updateData = {
      name:               name           ?? driver.name,
      phone:              phone          ?? driver.phone,
      email:              normalisedEmail,
      app_password:       appPassword    ? await bcrypt.hash(appPassword, 10) : driver.app_password,
      san_username:       sanUsername    ?? driver.san_username,
      san_password:       sanPassword    ? encrypt(sanPassword) : driver.san_password,
      vehicle_number:     vehicleNumber  ?? driver.vehicle_number,
      scheduled_time:     derivedScheduledTime,
      scheduled_days:     derivedScheduledDays,
      day_schedules:      derivedDaySchedules,
      scheduled_position: null,           // retired — all positions live in day_positions
      day_positions:      derivedDayPositions,
      is_active:          isActive       !== undefined ? isActive : driver.is_active,
      notes:              notes          ?? driver.notes,
    };

    const isScheduleUpdate = dayPositions  !== undefined || scheduledPosition !== undefined
                          || daySchedules  !== undefined || scheduledTime     !== undefined
                          || scheduledDays !== undefined;

    // When deactivating, release the driver's position claims so those slots
    // become available to other drivers immediately.
    const isDeactivating = isActive === false && driver.is_active === true;

    let updated;
    try {
      updated = await db.transaction(async (trx) => {
        const result = await Driver.update(req.params.id, updateData, trx);

        if (isDeactivating) {
          await PositionClaim.clearForDriver(req.params.id, trx);
        } else if (isScheduleUpdate) {
          const parsedDp = derivedDayPositions
            ? JSON.parse(derivedDayPositions)
            : {};
          await PositionClaim.setForDriver(req.params.id, parsedDp, trx);
        }

        return result;
      });
    } catch (err) {
      if (err.code === '23505') {
        err.statusCode = 409;
        throw err;
      }
      throw err;
    }

    // If the admin added or changed the driver's email, send a fresh verification
    // email and clear the verified timestamp so the new address gets confirmed.
    const emailChanged = normalisedEmail && normalisedEmail !== driver.email;
    if (emailChanged) {
      const verificationToken   = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db('drivers').where({ id: req.params.id }).update({
        email_verification_token:      verificationToken,
        email_verification_expires_at: verificationExpires,
        email_verified_at:             null,
      });
      sendVerificationEmail({ ...updated, email: normalisedEmail }, verificationToken).catch((err) =>
        console.error('[Email] Failed to send updated-email verification:', err.message),
      );
    }

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
    // Release position slots so other drivers can claim them immediately
    await PositionClaim.clearForDriver(req.params.id);
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

    // Run the bot and wait for the actual result (15–60 s)
    const result = await runBotForDriver(driver, 'manual');
    res.json({ result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/positions/check
 * Checks whether a set of (day, position) slots conflict with any other driver.
 * Used by the admin position modal Apply button for immediate inline feedback.
 * Body: { dayPositions: '{"2":10,"3":200}', driverId: 3 }
 */
async function checkPositions(req, res, next) {
  try {
    const { dayPositions, driverId } = req.body;
    let dp;
    try { dp = JSON.parse(dayPositions); } catch {
      const err = new Error('Invalid dayPositions JSON');
      err.statusCode = 400;
      throw err;
    }
    const conflict = await PositionClaim.checkConflicts(Number(driverId) || 0, dp);
    if (conflict) {
      return res.status(409).json({ error: conflict });
    }
    res.json({ ok: true });
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
  checkPositions,
  getLogs,
};
