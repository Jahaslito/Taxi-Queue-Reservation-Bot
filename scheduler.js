const cron = require('node-cron');
const db = require('./database');
const { addToQueue } = require('./bot');
const { decrypt } = require('./crypto');

// Track in-progress jobs to avoid duplicates
const runningJobs = new Set();

// Max concurrent Chromium instances — keeps memory under control and avoids
// hammering the SAN portal with too many simultaneous logins
const MAX_CONCURRENT = 5;

const MAX_RETRIES  = 3;
const BASE_RETRY_MS = 5000; // 5s → 10s → 20s (doubles each attempt) + up to 2s jitter

/**
 * Returns false for permanent failures that are not worth retrying:
 * wrong credentials or vehicle not found. Everything else (timeouts,
 * network errors, unexpected crashes) is treated as transient.
 */
function isTransientError(result) {
  const msg = (result.error || result.message || '').toLowerCase();
  if (msg.includes('invalid san') || msg.includes('check credentials') || msg.includes('login failed')) return false;
  if (msg.includes('not found')) return false;
  return true;
}

/**
 * Runs an array of drivers through the bot with a concurrency limit.
 * At most MAX_CONCURRENT bots run at the same time; the rest are queued.
 */
async function runWithConcurrencyLimit(drivers, triggerType) {
  const queue = [...drivers];
  const inFlight = new Set();

  function next() {
    while (inFlight.size < MAX_CONCURRENT && queue.length > 0) {
      const driver = queue.shift();
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

  // Wait for all in-flight jobs to finish
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }
}

/**
 * Runs the queue bot for a specific driver and records the result.
 */
async function runBotForDriver(driver, triggerType = 'scheduled') {
  const jobKey = `driver-${driver.id}`;
  if (runningJobs.has(jobKey)) {
    console.log(`[Scheduler] Skipping ${driver.name} (${driver.vehicle_number}) — already running`);
    return;
  }
  runningJobs.add(jobKey);

  // Insert a pending log entry
  const logId = db.prepare(`
    INSERT INTO logs (driver_id, triggered_at, trigger_type, status)
    VALUES (?, datetime('now'), ?, 'pending')
  `).run(driver.id, triggerType).lastInsertRowid;

  console.log(`[Scheduler] Starting bot for ${driver.name} (Vehicle: ${driver.vehicle_number})`);

  try {
    const sanPassword = decrypt(driver.san_password);
    let result;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        const jitter = Math.random() * 2000;
        const delay  = BASE_RETRY_MS * Math.pow(2, attempt - 2) + jitter;
        console.log(`[Scheduler] ↺ ${driver.name} — retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s…`);
        await new Promise(r => setTimeout(r, delay));
      }

      result = await addToQueue(driver.san_username, sanPassword, driver.vehicle_number);

      if (result.success || !isTransientError(result)) break;

      if (attempt < MAX_RETRIES) {
        console.log(`[Scheduler] ↺ ${driver.name} — transient failure, will retry (attempt ${attempt}/${MAX_RETRIES})`);
      }
    }

    if (result.success) {
      const status = result.alreadyQueued ? 'already_queued' : 'success';
      db.prepare(`
        UPDATE logs
        SET status = ?, queue_position = ?, queue_location = ?, queue_time = ?, duration_ms = ?
        WHERE id = ?
      `).run(status, result.position, result.location, result.queueTime, result.durationMs, logId);

      console.log(`[Scheduler] ✓ ${driver.name} → ${result.message}`);
    } else {
      db.prepare(`
        UPDATE logs SET status = 'failed', error_message = ?, duration_ms = ? WHERE id = ?
      `).run(result.error || result.message, result.durationMs, logId);

      console.error(`[Scheduler] ✗ ${driver.name} → ${result.message}`);
    }

    return result;
  } catch (err) {
    db.prepare(`
      UPDATE logs SET status = 'failed', error_message = ? WHERE id = ?
    `).run(err.message, logId);
    console.error(`[Scheduler] ✗ ${driver.name} → Unexpected error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    runningJobs.delete(jobKey);
  }
}

/**
 * Starts the cron job — runs every minute in Pacific Time.
 */
function startScheduler() {
  console.log('[Scheduler] Starting — checking every minute (Pacific Time)');

  cron.schedule('* * * * *', async () => {
    // Get current HH:MM in Pacific Time
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Los_Angeles'
    });
    const parts = formatter.formatToParts(now);
    const hour   = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const currentTime = `${hour}:${minute}`;

    // Find active drivers scheduled for this exact minute
    const drivers = db.prepare(`
      SELECT * FROM drivers WHERE is_active = 1 AND scheduled_time = ?
    `).all(currentTime);

    if (drivers.length === 0) return;

    console.log(`[Scheduler] ${currentTime} PT — Found ${drivers.length} driver(s) to process`);

    // Check each driver hasn't already been successfully processed today
    const today = now.toISOString().split('T')[0];

    const driversToRun = drivers.filter(driver => {
      const alreadyDone = db.prepare(`
        SELECT id FROM logs
        WHERE driver_id = ?
          AND date(triggered_at) = ?
          AND status IN ('success', 'already_queued')
      `).get(driver.id, today);

      if (alreadyDone) {
        console.log(`[Scheduler] Skipping ${driver.name} — already queued today`);
        return false;
      }
      return true;
    });

    if (driversToRun.length === 0) return;

    console.log(`[Scheduler] Running ${driversToRun.length} driver(s) — max ${MAX_CONCURRENT} concurrent`);

    // Fire-and-forget the whole batch (non-blocking for the cron tick)
    runWithConcurrencyLimit(driversToRun, 'scheduled').catch(console.error);
  }, {
    timezone: 'America/Los_Angeles'
  });

  console.log('[Scheduler] ✓ Cron job registered');
}

module.exports = { startScheduler, runBotForDriver };
