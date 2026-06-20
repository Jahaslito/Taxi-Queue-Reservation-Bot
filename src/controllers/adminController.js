const bcrypt                  = require('bcryptjs');
const crypto                  = require('crypto');
const db                      = require('../config/database');
const Driver                  = require('../models/Driver');
const Log                     = require('../models/Log');
const PositionClaim           = require('../models/PositionClaim');
const PositionTracking        = require('../models/PositionTracking');
const { encrypt, decrypt }    = require('../services/cryptoService');
const { runBotForDriver }     = require('../services/schedulerService');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { derivePaymentStatus } = require('../services/paymentStatus');

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

    // Annotate each row with the live credential-lockout state (in-memory,
    // day-scoped — see credentialLockoutService) so the admin UI can flag
    // locked-out drivers and offer the manual unlock action.
    const credentialLockout = require('../services/credentialLockoutService');
    const withLockState = drivers.map((d) => ({
      ...d,
      lockedOut:     credentialLockout.isLockedOut(Number(d.id)),
      paymentStatus: derivePaymentStatus(d),
    }));

    res.json({ drivers: withLockState, total: parseInt(countResult.count, 10), limit, offset });
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

    res.json({ ...driver, recentLogs, paymentStatus: derivePaymentStatus(driver) });
  } catch (err) {
    next(err);
  }
}

async function addDriver(req, res, next) {
  try {
    const { name, phone, email, sanUsername, sanPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules, maxAcceptablePosition, notes } = req.body;

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
      max_acceptable_position: Number.isInteger(maxAcceptablePosition) ? maxAcceptablePosition : null,
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

    const { name, phone, email, sanUsername, sanPassword, appPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules, scheduledPosition, dayPositions, maxAcceptablePosition, isActive, notes } = req.body;

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
    const normalisedEmail = (email !== undefined) ? (email.toLowerCase().trim() || null) : driver.email;

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
      // null = use default (target + 20); explicit integer = driver's preferred ceiling
      max_acceptable_position: maxAcceptablePosition !== undefined
        ? (Number.isInteger(maxAcceptablePosition) ? maxAcceptablePosition : null)
        : driver.max_acceptable_position,
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

    // Immediately propagate schedule changes to the monitor's in-memory state
    // so that position-scheduler decisions reflect the new dayPositions without
    // waiting for the next auto-refresh tick (up to 5 minutes). Mirrors the
    // same pattern used by markManuallyRemoved.
    if (isScheduleUpdate || isActive !== undefined) {
      try {
        const monitorService = require('../services/monitorService');
        if (typeof monitorService.syncDriverSchedule === 'function') {
          monitorService.syncDriverSchedule(req.params.id, {
            scheduledPosition:     null, // retired — always null
            dayPositions:          derivedDayPositions,
            maxAcceptablePosition: updateData.max_acceptable_position,
            // Propagate active-state change immediately so the monitor stops
            // requeueing the driver the moment the admin flips the toggle,
            // not after the next 5-minute auto-refresh.
            isActive: isActive !== undefined ? !!isActive : undefined,
          });
        }
      } catch (e) {
        console.warn('[Admin] Could not sync schedule to monitor:', e.message);
      }
    }

    // If SAN credentials changed, clear any active credential lockout AND the
    // cached Playwright session — both could re-fail with the old password
    // even after the admin saved the new one. Without this the day-scoped
    // breaker keeps short-circuiting the bot until midnight PT.
    const credsChanged = (sanUsername && sanUsername !== driver.san_username)
                      || !!sanPassword;
    let credentialCheck = null;
    if (credsChanged) {
      // Drop stale cached cookies for the OLD username (and the new one too —
      // harmless if it doesn't exist yet) so the verify does a clean full login.
      try {
        const { sessionStore } = require('../services/botService');
        if (sessionStore?.delete) {
          if (driver.san_username) sessionStore.delete(driver.san_username);
          if (sanUsername)         sessionStore.delete(sanUsername);
        }
      } catch { /* session store not exported — non-fatal */ }

      // CONFIRM the new credentials actually work against SAN (login-only round
      // trip) rather than blindly clearing the breaker. verifyCredentials maps
      // the outcome to the lockout: success clears it, a rejection re-arms it,
      // an unreachable SAN leaves it unchanged. Synchronous (~5 s) so the save
      // response can tell the admin whether the password is good.
      try {
        const { verifyCredentials } = require('../services/botService');
        credentialCheck = await verifyCredentials({
          driverId:      Number(req.params.id),
          sanUsername:   sanUsername || driver.san_username,
          sanPassword:   sanPassword || decrypt(driver.san_password),
          vehicleNumber: updateData.vehicle_number || driver.vehicle_number,
        });
      } catch (e) {
        console.warn('[Admin] Credential verify failed to run:', e.message);
        credentialCheck = { verified: null, reason: 'error', error: 'Verification could not run.' };
      }
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

    res.json({ ...updated, credentialCheck });
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

    // Immediately mark the driver inactive in the monitor's in-memory state so
    // auto-requeue stops right now rather than after the next 5-min refresh.
    try {
      const monitorService = require('../services/monitorService');
      if (typeof monitorService.syncDriverSchedule === 'function') {
        monitorService.syncDriverSchedule(req.params.id, { isActive: false });
      }
    } catch (e) {
      console.warn('[Admin] Could not notify monitor of deactivation:', e.message);
    }

    res.json({ message: 'Driver deactivated' });
  } catch (err) {
    next(err);
  }
}

// ─── Hard-delete a driver (irreversible) ─────────────────────────────────────
// Unlike deactivateDriver (a soft delete that flips is_active=false), this
// permanently removes the driver row and ALL their history. FK children cascade
// (logs, position_tracking, position_claims, sos_alerts → sos_location_history,
// driver_message_recipients). push_subscriptions is polymorphic (role +
// subscriber_id, NO foreign key) so it must be cleared explicitly or it orphans.
// Both run in one transaction so a mid-delete failure leaves nothing half-gone.
async function deleteDriver(req, res, next) {
  try {
    const id     = Number(req.params.id);
    const driver = await Driver.findById(id);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    await db.transaction(async (trx) => {
      await trx('push_subscriptions')
        .where({ role: 'driver', subscriber_id: id })
        .del();
      await trx('drivers').where({ id }).del();
    });

    // Stop the monitor acting on the now-deleted row immediately (the poll skips
    // inactive drivers); the next auto-refresh purges the watch entirely.
    try {
      const monitorService = require('../services/monitorService');
      if (typeof monitorService.syncDriverSchedule === 'function') {
        monitorService.syncDriverSchedule(id, { isActive: false });
      }
    } catch (e) {
      console.warn('[Admin] Could not notify monitor of deletion:', e.message);
    }

    console.log(`[Admin] Hard-deleted driver #${driver.vehicle_number} (id=${driver.id}, ${driver.name})`);
    res.json({ message: `Deleted ${driver.name} — vehicle #${driver.vehicle_number}` });
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

async function getPositionTracking(req, res, next) {
  try {
    const limit  = req.query.limit  ?? 50;
    const offset = req.query.offset ?? 0;
    const [rows, countRow] = await Promise.all([
      PositionTracking.recent({ limit, offset }),
      PositionTracking.recentCount(),
    ]);
    // Annotate each row with the exact outcome (locked out / already in queue /
    // not eligible / missed / waiting / landed) so the report names the cause
    // instead of a blanket "pending".
    const records = rows.map((r) => ({ ...r, outcome: PositionTracking.describeOutcome(r) }));
    res.json({ records, total: Number(countRow.count) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/reports/positions/:date?
 *
 * Returns the day's position-scheduler activity: one row per driver covering
 * the full lifecycle (waiting / fired / completed / missed_impossible / etc.)
 * plus aggregate stats — median error, counts by decision.
 *
 * :date defaults to today in Pacific Time (YYYY-MM-DD). Use 'yesterday' as a
 * shortcut for the previous PT day.
 */
async function getDailyReport(req, res, next) {
  try {
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    let date = req.params.date || 'today';

    if (date === 'today') {
      date = todayPT;
    } else if (date === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      date = y.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error('Date must be YYYY-MM-DD, "today", or "yesterday"');
      err.statusCode = 400;
      throw err;
    }

    // Run both queries in parallel — independent
    const [records, summary] = await Promise.all([
      PositionTracking.byDate(date),
      PositionTracking.dailySummary(date),
    ]);

    res.json({ date, summary, records });
  } catch (err) {
    next(err);
  }
}

// ─── Overnight carryover-removal report ───────────────────────────────────────
// Observability for the carryover fix: per removed leftover that day, shows
// "removed at Z → target W → landed K at U". Date defaults to today PT and
// accepts 'today'/'yesterday'/YYYY-MM-DD (same parsing as getDailyReport).
async function getCarryoverReport(req, res, next) {
  try {
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    let date = req.params.date || 'today';

    if (date === 'today') {
      date = todayPT;
    } else if (date === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      date = y.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error('Date must be YYYY-MM-DD, "today", or "yesterday"');
      err.statusCode = 400;
      throw err;
    }

    const rows = await PositionTracking.carryoverReport(date);
    const records = rows.map((r) => ({ ...r, outcome: PositionTracking.describeOutcome(r) }));
    res.json({ date, records });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/position-diagnostics
 *
 * Returns two sections for the Early Join Alerts admin page:
 *
 *   live    — current in-memory state for every position-scheduled driver:
 *             their target, scheduler status, and any early-join detection.
 *
 *   history — DB records of skip_already_seen events from the last 14 days,
 *             showing which drivers historically joined the queue before the
 *             position bot could fire.
 */
async function getPositionDiagnostics(req, res, next) {
  try {
    const monitorService = require('../services/monitorService');
    const live = typeof monitorService.getPositionDiagnostics === 'function'
      ? monitorService.getPositionDiagnostics()
      : [];

    const history = await PositionTracking.recentEarlyJoins({ days: 14 });

    res.json({ live, history });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/drivers/:id/rearm-position
 *
 * Re-arms the position scheduler for a single driver today — clears
 * positionFiredToday, earlyJoinDetectedAt/Position, and inQueueFromCarryover
 * so the scheduler will try again at the right burst-window moment.
 *
 * This is the single-driver equivalent of the 3 AM auto-arm. Safe to call at
 * any time; if the driver is already in queue the carryover guard prevents an
 * immediate double-fire.
 */
async function rearmPositionScheduler(req, res, next) {
  try {
    const monitorService = require('../services/monitorService');
    const driverId = parseInt(req.params.id, 10);

    if (typeof monitorService.allowRefireToday !== 'function') {
      return res.status(503).json({ error: 'Monitor service not running' });
    }

    const ok = monitorService.allowRefireToday(driverId);
    if (!ok) {
      return res.status(404).json({ error: 'Driver not found in active monitor' });
    }

    // Also clear the early-join fields via the internal state reference
    const state = monitorService._getInternalState?.(driverId);
    if (state) {
      state.earlyJoinDetectedAt = null;
      state.earlyJoinAtPosition = null;
    }

    res.json({ ok: true, message: `Position scheduler re-armed for driver ${driverId}` });
  } catch (err) {
    next(err);
  }
}

// ─── Send password reset link to a driver ────────────────────────────────────
async function sendDriverPasswordReset(req, res, next) {
  try {
    const driver = await Driver.findById(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (!driver.email) {
      return res.status(400).json({ error: 'Driver has no email address — add one via Edit first.' });
    }

    const resetToken   = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db('drivers').where({ id: driver.id }).update({
      password_reset_token:      resetToken,
      password_reset_expires_at: resetExpires,
    });

    await sendPasswordResetEmail(driver, resetToken);

    res.json({ message: `Reset link sent to ${driver.email}` });
  } catch (err) {
    next(err);
  }
}

// ─── Manually clear a credential lockout ──────────────────────────────────────
// The day-scoped breaker (credentialLockoutService) parks a driver until
// midnight PT once SAN rejects their login, so the bot stops burning fire slots
// on a guaranteed-failed account. It already self-clears on a successful run or
// a password change — this endpoint is the manual escape hatch: the admin
// confirmed the SAN password is fine (or was fixed on SAN's side) and wants the
// bot to retry now, without editing the password. We also drop the cached
// Playwright session so a stale bad-cookie jar can't immediately re-trip the
// lock on the next run.
async function unlockCredentials(req, res, next) {
  try {
    const driverId = parseInt(req.params.id, 10);
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const credentialLockout = require('../services/credentialLockoutService');
    const wasLocked = credentialLockout.isLockedOut(driverId);
    credentialLockout.clearLockout(driverId);

    try {
      const { sessionStore } = require('../services/botService');
      if (sessionStore?.delete && driver.san_username) sessionStore.delete(driver.san_username);
    } catch { /* session store not exported — non-fatal */ }

    res.json({
      ok: true,
      wasLocked,
      message: wasLocked
        ? `Credential lock cleared for ${driver.name} — the bot will retry on the next fire.`
        : `${driver.name} was not locked out.`,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Confirm a driver's SAN credentials work (live login test) ────────────────
// Does a login-only round-trip to SAN with the driver's stored password and
// reports whether it's valid. Authoritatively updates the credential breaker:
// success clears the lock, a rejection arms it, an unreachable SAN leaves it
// unchanged. ~5 s — it launches a headless browser.
async function verifyDriverCredentials(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (!driver.san_username || !driver.san_password) {
      return res.status(400).json({ error: 'Driver has no SAN credentials on file.' });
    }

    const { verifyCredentials } = require('../services/botService');
    const check = await verifyCredentials({
      driverId:      Number(req.params.id),
      sanUsername:   driver.san_username,
      sanPassword:   decrypt(driver.san_password),
      vehicleNumber: driver.vehicle_number,
    });

    const message = check.verified === true
      ? `✓ SAN accepted ${driver.name}'s login — credentials are valid.`
      : check.verified === false
        ? `✗ SAN rejected ${driver.name}'s username or password.`
        : `⚠ Couldn't reach SAN to verify ${driver.name} — lock left unchanged.`;

    res.json({ ...check, message });
  } catch (err) {
    next(err);
  }
}

// ─── Manually lock a driver out until they add a card ─────────────────────────
// Immediate version of the card-enforcement sweep: deactivates the driver
// (is_active=false stops the bot + shows them as inactive) and stamps
// card_required_by=now. They can still log in (auth relaxes for billing-locked
// drivers) and land on the "Add a Card to Reactivate" screen; the Stripe webhook
// flips them back to active the moment a card is confirmed. Intended for drivers
// with no card on file — the admin UI only surfaces this for that cohort.
async function requireCard(req, res, next) {
  try {
    const driver = await Driver.findById(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    await Driver.update(driver.id, {
      is_active:           false,
      subscription_status: 'past_due',
      card_required_by:    new Date(),
    });

    console.log(`[Admin] Driver ${driver.id} (#${driver.vehicle_number}) locked — card required`);
    res.json({ ok: true, message: `${driver.name} is locked out until they add a card.` });
  } catch (err) {
    next(err);
  }
}

// ─── Clear a card requirement (admin waiver / undo a mistaken lock) ────────────
// Restores grandfathered access: clears the deadline, re-activates, and puts the
// subscription back to active. Use when a driver should keep access without a
// card, or to reverse an accidental lock.
async function clearCardRequirement(req, res, next) {
  try {
    const driver = await Driver.findById(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    await Driver.update(driver.id, {
      is_active:           true,
      subscription_status: 'active',
      card_required_by:    null,
    });

    console.log(`[Admin] Driver ${driver.id} (#${driver.vehicle_number}) card requirement cleared`);
    res.json({ ok: true, message: `Card requirement cleared for ${driver.name}.` });
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
  deleteDriver,
  triggerDriver,
  checkPositions,
  getLogs,
  getPositionTracking,
  getDailyReport,
  getPositionDiagnostics,
  rearmPositionScheduler,
  sendDriverPasswordReset,
  unlockCredentials,
  verifyDriverCredentials,
  getCarryoverReport,
  requireCard,
  clearCardRequirement,
};
