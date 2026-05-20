const cron    = require('node-cron');
const Driver  = require('../models/Driver');
const Log     = require('../models/Log');
const { decrypt }    = require('./cryptoService');
const { addToQueue } = require('./botService');

// In-memory set prevents the same driver from running twice simultaneously
const runningJobs = new Set();

const MAX_CONCURRENT = parseInt(process.env.SCHEDULER_CONCURRENCY ?? '5', 10);
const MAX_RETRIES    = 3;
// Both values are overridable via env so tests can set them to 0 for speed
const BASE_RETRY_MS  = parseInt(process.env.RETRY_BASE_MS  ?? '5000', 10); // 5s → 10s → 20s
const MAX_JITTER_MS  = parseInt(process.env.RETRY_JITTER_MS ?? '2000', 10); // up to 2s jitter

/**
 * Returns false for permanent failures that are not worth retrying
 * (wrong credentials, vehicle not found). Everything else is transient.
 */
function isTransientError(result) {
  if (result.dispatched) return false;
  const msg = (result.error || result.message || '').toLowerCase();
  if (msg.includes('invalid san') || msg.includes('check credentials') || msg.includes('login failed')) return false;
  if (msg.includes('not found')) return false;
  return true;
}

/**
 * Runs an array of drivers through the bot with a hard concurrency ceiling.
 * At most MAX_CONCURRENT Chromium instances run simultaneously.
 */
async function runWithConcurrencyLimit(drivers, triggerType) {
  const queue    = [...drivers];
  const inFlight = new Set();

  function next() {
    while (inFlight.size < MAX_CONCURRENT && queue.length > 0) {
      const driver  = queue.shift();
      const promise = runBotForDriver(driver, triggerType)
        .catch(console.error)
        .finally(() => {
          inFlight.delete(promise);
          next();
        });
      inFlight.add(promise);
    }
  }

  next();

  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }
}

/**
 * Runs the queue bot for a single driver, records the result to the logs
 * table, and retries on transient failures with exponential back-off + jitter.
 */
async function runBotForDriver(driver, triggerType = 'scheduled') {
  const jobKey = `driver-${driver.id}`;

  if (runningJobs.has(jobKey)) {
    console.log(`[Scheduler] Skipping ${driver.name} (${driver.vehicle_number}) — already running`);
    return;
  }
  runningJobs.add(jobKey);

  const logId = await Log.create({
    driver_id:    driver.id,
    triggered_at: new Date(),
    trigger_type: triggerType,
    status:       'pending',
  });

  console.log(`[Scheduler] Starting bot for ${driver.name} (Vehicle: ${driver.vehicle_number})`);

  try {
    const sanPassword = decrypt(driver.san_password);
    let result;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        const jitter = Math.random() * MAX_JITTER_MS;
        const delay  = BASE_RETRY_MS * Math.pow(2, attempt - 2) + jitter;
        console.log(`[Scheduler] ↺ ${driver.name} — retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s…`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      result = await addToQueue(driver.san_username, sanPassword, driver.vehicle_number);

      if (result.success || !isTransientError(result)) break;

      if (attempt < MAX_RETRIES) {
        console.log(`[Scheduler] ↺ ${driver.name} — transient failure, will retry (attempt ${attempt}/${MAX_RETRIES})`);
      }
    }

    if (result.success) {
      const status = result.alreadyQueued ? 'already_queued' : 'success';
      await Log.update(logId, {
        status,
        queue_position: result.position,
        queue_location: result.location,
        queue_time:     result.queueTime,
        duration_ms:    result.durationMs,
      });
      console.log(`[Scheduler] ✓ ${driver.name} → ${result.message}`);
    } else {
      await Log.update(logId, {
        status:        'failed',
        error_message: result.error || result.message,
        duration_ms:   result.durationMs,
      });
      console.error(`[Scheduler] ✗ ${driver.name} → ${result.message}`);
    }

    return result;
  } catch (err) {
    await Log.update(logId, { status: 'failed', error_message: err.message });
    console.error(`[Scheduler] ✗ ${driver.name} → Unexpected error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    runningJobs.delete(jobKey);
  }
}

/**
 * Registers the cron job. Fires every minute in Pacific Time,
 * finds drivers scheduled for that exact minute, and runs bots
 * for any that have not yet been successfully queued today.
 */
function startScheduler() {
  console.log('[Scheduler] Starting — checking every minute (Pacific Time)');

  cron.schedule('* * * * *', async () => {
    try {
      // Get current HH:MM and day-of-week in Pacific Time
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles',
      });
      const parts = formatter.formatToParts(now);
      const hour = parts.find(p => p.type === 'hour').value;
      const minute = parts.find(p => p.type === 'minute').value;
      const currentTime = `${hour}:${minute}`;

      const dayOfWeekStr = new Date().toLocaleDateString('en-US', {
        weekday: 'short', timeZone: 'America/Los_Angeles',
      });
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const todayDay = String(dayMap[dayOfWeekStr]);
      const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

      // Fetch all active drivers
      const allDrivers = await Driver.findAllActive();

      // Filter to those scheduled right now
      const drivers = allDrivers.filter(driver => {
        // Position-scheduled drivers are triggered by the monitor, not cron
        if (driver.scheduled_position || driver.day_positions) return false;

        if (driver.day_schedules) {
          try {
            const ds = JSON.parse(driver.day_schedules);
            return ds[todayDay] === currentTime;
          } catch { return false; }
        }
        // Legacy fallback: use scheduled_time + scheduled_days
        const activeDays = (driver.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
        return activeDays.includes(todayDay) && driver.scheduled_time === currentTime;
      });

      if (!drivers.length) return;

      console.log(`[Scheduler] ${currentTime} PT — Found ${drivers.length} driver(s) to process`);

      const driversToRun = [];
      for (const driver of drivers) {
        const alreadyDone = await Log.findSuccessToday(driver.id, today);
        if (alreadyDone) {
          console.log(`[Scheduler] Skipping ${driver.name} — already queued today`);
        } else {
          driversToRun.push(driver);
        }
      }

      if (!driversToRun.length) return;

      console.log(`[Scheduler] Running ${driversToRun.length} driver(s) — max ${MAX_CONCURRENT} concurrent`);

      // Fire-and-forget — does not block the cron tick
      runWithConcurrencyLimit(driversToRun, 'scheduled').catch(console.error);
    } catch (err) {
      console.error('[Scheduler] Error in cron tick:', err.message);
    }
  }, {
    timezone: 'America/Los_Angeles',
  });

  console.log('[Scheduler] ✓ Cron job registered');
}

module.exports = { startScheduler, runBotForDriver };
