const bcrypt            = require('bcryptjs');
const db                = require('../config/database');
const Driver            = require('../models/Driver');
const Log               = require('../models/Log');
const PositionClaim     = require('../models/PositionClaim');
const { encrypt }       = require('../services/cryptoService');
const { runBotForDriver, runRemoveBotForDriver } = require('../services/schedulerService');

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

    const { name, phone, scheduledTime, scheduledDays, daySchedules, scheduledPosition, dayPositions, sanUsername, sanPassword, vehicleNumber, currentPassword, newAppPassword } = req.body;

    if (newAppPassword) {
      if (!currentPassword) {
        const err = new Error('Current password is required to set a new password');
        err.statusCode = 400;
        throw err;
      }
      const match = await bcrypt.compare(currentPassword, driver.app_password);
      if (!match) {
        const err = new Error('Current password is incorrect');
        err.statusCode = 400;
        throw err;
      }
    }

    // One-at-a-time: position-based and time-based scheduling are mutually exclusive.
    let derivedScheduledTime     = scheduledTime || driver.scheduled_time;
    let derivedScheduledDays     = scheduledDays   !== undefined ? scheduledDays   : driver.scheduled_days;
    let derivedDaySchedules      = daySchedules    !== undefined ? daySchedules    : driver.day_schedules;
    let derivedScheduledPosition = scheduledPosition !== undefined ? (scheduledPosition || null) : driver.scheduled_position;
    let derivedDayPositions      = dayPositions    !== undefined ? dayPositions    : driver.day_positions;

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

    const updateData = {
      name:               name           || driver.name,
      phone:              phone          !== undefined ? phone : driver.phone,
      scheduled_time:     derivedScheduledTime,
      scheduled_days:     derivedScheduledDays,
      day_schedules:      derivedDaySchedules,
      scheduled_position: null,           // retired — all positions live in day_positions
      day_positions:      derivedDayPositions,
      san_username:       sanUsername    || driver.san_username,
      san_password:       sanPassword    ? encrypt(sanPassword)                  : driver.san_password,
      vehicle_number:     vehicleNumber  || driver.vehicle_number,
      app_password:       newAppPassword ? await bcrypt.hash(newAppPassword, 10) : driver.app_password,
    };

    // Sync position_claims whenever any schedule field is explicitly in the request.
    // This covers: saving positions, switching to time-based (clears claims), and
    // updating days/times (no-op for claims but keeps the guard simple).
    const isScheduleUpdate = dayPositions  !== undefined || scheduledPosition !== undefined
                          || daySchedules  !== undefined || scheduledTime     !== undefined
                          || scheduledDays !== undefined;

    let updated;
    try {
      updated = await db.transaction(async (trx) => {
        const result = await Driver.update(req.driverId, updateData, trx);

        if (isScheduleUpdate) {
          const parsedDp = derivedDayPositions
            ? JSON.parse(derivedDayPositions)
            : {};
          await PositionClaim.setForDriver(req.driverId, parsedDp, trx);
        }

        return result;
      });
    } catch (err) {
      if (err.code === '23505') {
        // setForDriver always formats 23505 messages before throwing — just tag status
        err.statusCode = 409;
        throw err;
      }
      throw err;
    }

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

async function triggerSelf(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found'); err.statusCode = 404; throw err;
    }
    if (!driver.is_active) {
      const err = new Error('Your account is inactive'); err.statusCode = 400; throw err;
    }
    // Respond immediately — bot runs in the background
    res.json({ message: 'Bot triggered — check your History tab for the result.' });
    runBotForDriver(driver, 'manual').catch(console.error);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/driver/remove-queue
 *
 * Triggers the remove-from-queue bot. Unlike triggerSelf, this awaits the bot
 * result so we can update the driver's state synchronously based on the outcome:
 *   • success           → set manually_removed_at, notify monitor to stop auto-requeueing
 *   • dispatched        → 409, don't change state
 *   • notInQueue        → 200 with informational message
 *   • other failures    → 500/502 with friendly message
 *
 * Bot run time is 5–15 seconds. Frontend shows a loading state during the wait.
 */
async function removeFromQueue(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found'); err.statusCode = 404; throw err;
    }
    if (!driver.is_active) {
      const err = new Error('Your account is inactive'); err.statusCode = 400; throw err;
    }

    const result = await runRemoveBotForDriver(driver, 'manual_remove');

    // Hard failures (dispatched / not in queue / login error / network) — don't modify state
    if (!result.success) {
      if (result.dispatched) {
        return res.status(409).json({
          ok:      false,
          reason:  'dispatched',
          message: result.message,
        });
      }
      if (result.notInQueue) {
        return res.status(200).json({
          ok:      false,
          reason:  'not_in_queue',
          message: result.message,
        });
      }
      const err = new Error(result.message || result.error || 'Failed to remove from queue');
      err.statusCode = 502;
      throw err;
    }

    // Success — mark the driver removed and update the in-memory monitor state
    // so it knows not to auto-requeue them for the rest of the day.
    await Driver.update(req.driverId, { manually_removed_at: new Date() });

    // Notify monitorService so the in-memory state matches the DB immediately.
    // Lazy-require to avoid circular import (monitorService → schedulerService → controllers).
    try {
      const monitorService = require('../services/monitorService');
      if (typeof monitorService.markManuallyRemoved === 'function') {
        monitorService.markManuallyRemoved(req.driverId);
      }
    } catch (e) {
      console.warn('[Driver] Could not notify monitor of manual removal:', e.message);
    }

    res.json({
      ok:      true,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, getLogs, getTodayStatus, triggerSelf, removeFromQueue };
