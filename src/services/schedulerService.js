const cron    = require('node-cron');
const Driver  = require('../models/Driver');
const Log     = require('../models/Log');
const { decrypt }    = require('./cryptoService');
const { addToQueue, removeFromQueue, sanitizeError } = require('./botService');
const credentialLockout = require('./credentialLockoutService');

// In-memory set prevents the same driver from running twice simultaneously
const runningJobs = new Set();

const MAX_CONCURRENT = parseInt(process.env.SCHEDULER_CONCURRENCY ?? '5', 10);
const MAX_RETRIES    = 3;
// Both values are overridable via env so tests can set them to 0 for speed
const BASE_RETRY_MS  = parseInt(process.env.RETRY_BASE_MS  ?? '5000', 10); // 5s → 10s → 20s
const MAX_JITTER_MS  = parseInt(process.env.RETRY_JITTER_MS ?? '2000', 10); // up to 2s jitter

// ─── Global bot semaphore ─────────────────────────────────────────────────────
// Caps concurrent Chromium instances across ALL cron ticks.
// Without this, overlapping ticks (e.g. 5:00 batch still running when 5:01
// fires) would each enforce their own local cap, silently doubling total
// concurrency and potentially OOM-ing the server.
class BotSemaphore {
  constructor(max) {
    this._max     = max;
    this._running = 0;
    this._waiting = []; // pending resolve callbacks
  }

  acquire() {
    if (this._running < this._max) {
      this._running++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._waiting.push(resolve));
  }

  release() {
    if (this._waiting.length > 0) {
      // Hand the slot directly to the next waiter — _running stays the same
      this._waiting.shift()();
    } else {
      this._running = Math.max(0, this._running - 1);
    }
  }

  get active() { return this._running; }
}

const botSemaphore = new BotSemaphore(MAX_CONCURRENT);

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
 * Runs an array of drivers through the bot respecting the global semaphore.
 * All callers (every cron tick) share the same BotSemaphore, so the cap of
 * MAX_CONCURRENT browsers is enforced globally — not just within one batch.
 */
async function runWithConcurrencyLimit(drivers, triggerType) {
  await Promise.all(
    drivers.map(async (driver) => {
      await botSemaphore.acquire();
      try {
        await runBotForDriver(driver, triggerType);
      } catch (err) {
        console.error('[Scheduler] Unexpected error in bot run:', err.message);
      } finally {
        botSemaphore.release();
      }
    }),
  );
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

  // Credential breaker — if the bot already confirmed today that SAN rejects
  // this driver's credentials, don't waste a Chromium slot retrying. The
  // lockout self-expires at midnight PT, and clears immediately whenever the
  // driver edits their SAN password via the API. Returns a result shaped like
  // a normal bot failure so callers can log/render it uniformly.
  const lockout = credentialLockout.getLockout(driver.id);
  if (lockout) {
    const msg = 'Invalid SAN username or password — update your SAN password and try again';
    console.log(`[Scheduler] ⛔ Skipping ${driver.name} (${driver.vehicle_number}) — locked out (${lockout.reason})`);
    await Log.create({
      driver_id:     driver.id,
      triggered_at:  new Date(),
      trigger_type:  triggerType,
      status:        'failed',
      error_message: msg,
    });
    return { success: false, error: msg, message: msg, durationMs: 0 };
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
      // Bot just logged in successfully — credentials must be valid, so any
      // stale lockout from earlier today (e.g. driver since updated password)
      // can be cleared.
      credentialLockout.clearLockout(driver.id);
      console.log(`[Scheduler] ✓ ${driver.name} → ${result.message}`);
    } else {
      await Log.update(logId, {
        status:        'failed',
        error_message: result.error || result.message,
        duration_ms:   result.durationMs,
      });
      // Arm the day-scoped breaker on credential errors so subsequent retries
      // for this driver short-circuit instead of timing out the same way.
      if (credentialLockout.isCredentialError(result.error || result.message)) {
        credentialLockout.lockOut(driver.id, result.error || result.message);
      }
      console.error(`[Scheduler] ✗ ${driver.name} → ${result.message}`);
    }

    return result;
  } catch (err) {
    const friendly = sanitizeError(err.message);
    await Log.update(logId, { status: 'failed', error_message: friendly });
    console.error(`[Scheduler] ✗ ${driver.name} → Unexpected error: ${err.message}`);
    return { success: false, error: friendly };
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

      // One query for all drivers — replaces N sequential round-trips
      const driverIds    = drivers.map(d => d.id);
      const alreadyDoneIds = await Log.findSuccessTodayBatch(driverIds, today);

      const driversToRun = [];
      for (const driver of drivers) {
        if (alreadyDoneIds.has(driver.id)) {
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

/**
 * Runs the remove-from-queue bot for a single driver. Mirrors runBotForDriver
 * but calls removeFromQueue() instead of addToQueue() and uses the 'manual_remove'
 * trigger_type. No retries — if it fails, the driver can simply try again.
 */
async function runRemoveBotForDriver(driver, triggerType = 'manual_remove') {
  const jobKey = `driver-${driver.id}`;

  if (runningJobs.has(jobKey)) {
    console.log(`[Scheduler] (remove) Skipping ${driver.name} (${driver.vehicle_number}) — bot already running`);
    return { success: false, error: 'Another bot is already running for this driver' };
  }
  runningJobs.add(jobKey);

  const logId = await Log.create({
    driver_id:    driver.id,
    triggered_at: new Date(),
    trigger_type: triggerType,
    status:       'pending',
  });

  console.log(`[Scheduler] (remove) Starting bot for ${driver.name} (Vehicle: ${driver.vehicle_number})`);

  try {
    const sanPassword = decrypt(driver.san_password);
    const result = await removeFromQueue(driver.san_username, sanPassword, driver.vehicle_number);

    if (result.success) {
      await Log.update(logId, {
        status:        'success',
        duration_ms:   result.durationMs,
        error_message: 'manually_removed',  // tag for analytics
      });
      console.log(`[Scheduler] (remove) ✓ ${driver.name} → ${result.message}`);
    } else {
      await Log.update(logId, {
        status:        'failed',
        error_message: result.error || result.message,
        duration_ms:   result.durationMs,
      });
      console.error(`[Scheduler] (remove) ✗ ${driver.name} → ${result.message}`);
    }

    return result;
  } catch (err) {
    const friendly = sanitizeError(err.message);
    await Log.update(logId, { status: 'failed', error_message: friendly });
    console.error(`[Scheduler] (remove) ✗ ${driver.name} → Unexpected error: ${err.message}`);
    return { success: false, error: friendly };
  } finally {
    runningJobs.delete(jobKey);
  }
}

module.exports = { startScheduler, runBotForDriver, runRemoveBotForDriver };
