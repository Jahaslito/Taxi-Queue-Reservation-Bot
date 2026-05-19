'use strict';

// ─── Queue Monitor Service ────────────────────────────────────────────────────
//
// Polls the public V Holding queue page once every POLL_INTERVAL_MS.
// A single HTTP fetch serves ALL watched drivers — cost is O(1) regardless
// of driver count. State is kept in-memory; DB is written only when the
// bot actually runs.
//
// Two watch sources:
//   AUTO   — every is_active driver, loaded on start, refreshed every 5 min.
//   MANUAL — added via the Monitor page "Watch Vehicle" button.
//
// State machine per driver:
//
//   watching ──(seen in queue)──► in_queue ──(dispatched row)──► dispatched
//      ▲                              │                               │
//      │                        (gone + seen)               (gone + seen)
//      │                              ▼                               ▼
//      └──────────────────────── requeuing ◄──────────────────── gone
//                                    │
//                         (bot done) │
//                                    ▼
//                               watching  (next poll re-enters in_queue)
//
// Scalability notes:
//   • One HTTP fetch per tick regardless of driver count (O(1) network cost).
//   • O(n) in-memory state-machine pass with cheap Set lookups.
//   • Bot jobs are concurrency-capped (MONITOR_CONCURRENCY, default 3) to
//     prevent a Playwright stampede when many drivers go "gone" simultaneously.
//   • EventEmitter supports up to 500 SSE clients.

const { EventEmitter } = require('events');
const Driver           = require('../models/Driver');
const Log              = require('../models/Log');

// ─── Constants (overridable via env for testing / tuning) ────────────────────
const POLL_INTERVAL_MS  = parseInt(process.env.MONITOR_POLL_MS     ?? String(90_000), 10);
const FETCH_TIMEOUT     = parseInt(process.env.MONITOR_TIMEOUT     ?? String(15_000), 10);
const BOT_CONCURRENCY   = parseInt(process.env.MONITOR_CONCURRENCY ?? '3',                10);
const AUTO_REFRESH_MS   = parseInt(process.env.MONITOR_REFRESH_MS  ?? String(5 * 60_000), 10);
const RETRY_COUNT       = parseInt(process.env.MONITOR_RETRY_COUNT ?? '3',                10);
// Delays between successive retry attempts (ms). Index 0 = after 1st failure.
const RETRY_DELAYS      = [5_000, 15_000, 30_000];
// How long to wait after detecting a driver is gone before firing the auto-requeue bot.
// Gives the SAN server time to finish processing the dispatch before accepting a re-queue.
// Does NOT apply to manual Run button or scheduled triggers.
const AUTO_REQUEUE_DELAY_MS = parseInt(process.env.MONITOR_REQUEUE_DELAY_MS ?? String(60_000), 10);

// ─── Operating hours (Pacific Time) ──────────────────────────────────────────
// Auto-requeue only fires between START_HOUR and END_HOUR (24h, PT).
// Manual runs via the Run button are never gated by this.
const OP_START_HOUR = parseInt(process.env.MONITOR_START_HOUR ?? '8',  10); //  8 AM PT
const OP_END_HOUR   = parseInt(process.env.MONITOR_END_HOUR   ?? '23', 10); // 11 PM PT

function isWithinOperatingHours() {
  const hour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour:     'numeric',
      hour12:   false,
    }),
    10,
  );
  return hour >= OP_START_HOUR && hour < OP_END_HOUR;
}

const QUEUE_URL = process.env.MONITOR_QUEUE_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-17';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Concurrency-limited job queue ───────────────────────────────────────────
// Caps simultaneous Playwright bot sessions so a wave of departures (e.g.
// 50 drivers dispatched at once) doesn't spawn 50 browser processes.
class JobQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running     = 0;
    this.pending     = []; // { fn, resolve, reject }
    this.totalQueued = 0;
    this.totalDone   = 0;
  }

  enqueue(fn) {
    this.totalQueued++;
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this._tick();
    });
  }

  _tick() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const { fn, resolve, reject } = this.pending.shift();
      this.running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this.totalDone++;
          this._tick();
        });
    }
  }

  get activeCount()  { return this.running; }
  get pendingCount() { return this.pending.length; }
}

const jobQueue = new JobQueue(BOT_CONCURRENCY);

// ─── In-memory state ─────────────────────────────────────────────────────────
/**
 * Map<driverId, DriverWatchState>
 *
 * DriverWatchState = {
 *   driverId:          number
 *   driverName:        string
 *   vehicleNumber:     string   — raw value from DB
 *   vehicleNorm:       string   — normalised for comparison
 *   isAuto:            boolean  — true = auto-watched (active driver), false = manual watch
 *   state:             'watching'|'in_queue'|'dispatched'|'gone'|'requeuing'
 *   hasBeenSeen:       boolean  — true once observed in the queue this session
 *   addedAt:           Date
 *   lastSeenAt:        Date|null
 *   lastDispatchAt:    Date|null
 *   lastGoneAt:        Date|null
 *   lastRequeuedAt:    Date|null
 *   lastResult:        {success, position?, error?, message?}|null
 *   requeueCount:      number   — total since server start
 *   requeueCountToday: number   — resets at midnight Pacific
 *   lastPosition:      number|null
 * }
 */
const watches = new Map();

/** Track which driverIds are auto-managed (so we can remove deactivated drivers) */
const autoDriverIds = new Set();

/** Track which driverIds were explicitly added via "Watch Vehicle" on the Monitor page */
const manualWatchIds = new Set();

/** Today's date in PT — used to detect day rollover for counter reset */
let todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/** Stats from the most recent successful poll */
let lastPollStats = {
  pollAt:       null,
  totalInQueue: 0,
  dispatched:   0,
  waiting:      0,
  fetchMs:      0,
  queueUrl:     QUEUE_URL,
  error:        null,
};

let pollTimer    = null;
let refreshTimer = null;

// EventEmitter — decouples SSE clients from service logic
const emitter = new EventEmitter();
emitter.setMaxListeners(500); // support many concurrent admin browser tabs

// ─── HTML parser (zero dependencies) ─────────────────────────────────────────
/** Normalise a vehicle ID: strip whitespace, uppercase. */
const norm = (id) => String(id ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * Parse V Holding HTML into two Maps of normalised vehicleId → row position.
 * Splits on '<tr ' to isolate data rows, finds `font-weight:bold` cells.
 * Position is the number in the first <td> of each row (the queue rank).
 * ~2ms for a 455-row page; scales linearly with page size.
 */
function parseQueue(html) {
  const dispatched = new Map(); // vehicleId → position number
  const waiting    = new Map(); // vehicleId → position number

  const chunks = html.split('<tr ');
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.startsWith('class="')) continue;

    const clsEnd  = chunk.indexOf('"', 7);
    const cls     = chunk.slice(7, clsEnd);

    // Position is in the first <td style="">N</td> before the bold vehicle-number <td>
    // The cell is always rendered as <td style="">number</td>
    const firstTdStart = chunk.indexOf('<td style="">');
    const firstTdEnd   = firstTdStart !== -1 ? chunk.indexOf('</td>', firstTdStart) : -1;
    const position     = firstTdEnd !== -1
      ? parseInt(chunk.slice(firstTdStart + 13, firstTdEnd), 10) || null
      : null;

    // Vehicle ID is in the bold <td>
    const boldIdx  = chunk.indexOf('font-weight:bold');
    if (boldIdx === -1) continue;
    const valStart = chunk.indexOf('>', boldIdx) + 1;
    const valEnd   = chunk.indexOf('<', valStart);
    if (valStart <= 0 || valEnd <= valStart) continue;

    const vehicleId = norm(chunk.slice(valStart, valEnd));
    if (!vehicleId) continue;

    if (cls === 'holdingdispatched') dispatched.set(vehicleId, position);
    else                             waiting.set(vehicleId, position);
  }

  return { dispatched, waiting };
}

// ─── SSE broadcast ───────────────────────────────────────────────────────────
function broadcast(type, payload) {
  emitter.emit('event', { type, payload, ts: Date.now() });
}

// ─── State snapshot (safe for JSON / SSE) ────────────────────────────────────
function snap(state) {
  return {
    driverId:          state.driverId,
    driverName:        state.driverName,
    vehicleNumber:     state.vehicleNumber,
    isAuto:            state.isAuto,
    isManual:          manualWatchIds.has(state.driverId),
    state:             state.state,
    hasBeenSeen:       state.hasBeenSeen,
    addedAt:           state.addedAt,
    lastSeenAt:        state.lastSeenAt,
    lastDispatchAt:    state.lastDispatchAt,
    lastGoneAt:        state.lastGoneAt,
    lastRequeuedAt:    state.lastRequeuedAt,
    lastResult:        state.lastResult,
    requeueCount:      state.requeueCount,
    requeueCountToday: state.requeueCountToday,
    currentPosition:   state.currentPosition,   // live position from last poll
    lastPosition:      state.lastPosition,       // position bot placed them at
  };
}

// ─── Re-queue trigger (used by auto-detection & manual run) ──────────────────
async function _runBot(driverId, state) {
  // Lazy-require to break circular dependency (monitorService ← schedulerService).
  const { runBotForDriver } = require('./schedulerService');

  const driver = await Driver.findByIdWithCredentials(driverId);
  if (!driver || !driver.is_active) throw new Error('Driver not found or inactive');

  const result = await runBotForDriver(driver, 'monitor_requeue');

  state.lastResult  = result;
  state.state       = 'watching';
  state.hasBeenSeen = false; // next poll re-confirms in_queue
  if (result?.success && !result?.alreadyQueued) {
    state.requeueCount++;
    state.requeueCountToday++;
  }
  if (result?.position) state.lastPosition = result.position;

  broadcast('requeue_result', {
    driverId,
    driverName:    state.driverName,
    vehicleNumber: state.vehicleNumber,
    result,
    isAuto:        state.isAuto,
  });
  broadcast('driver_state', { driverId, state: snap(state) });
  console.log(`[Monitor] ✓ Re-queue #${state.vehicleNumber}: ${result?.success ? `pos #${result.position}` : 'failed'}`);
}

async function triggerRequeue(driverId, state, { delayMs = 0 } = {}) {
  state.state          = 'requeuing';
  state.lastRequeuedAt = new Date();
  broadcast('driver_state',      { driverId, state: snap(state) });
  broadcast('requeue_triggered', { driverId, vehicleNumber: state.vehicleNumber });

  const delayNote = delayMs > 0 ? ` — bot queued in ${delayMs / 1000}s` : '';
  console.log(`[Monitor] ⚡ Re-queue scheduled for #${state.vehicleNumber}${delayNote} (queue: ${jobQueue.activeCount} active, ${jobQueue.pendingCount} pending)`);

  const enqueue = () => {
    console.log(`[Monitor] ▶ #${state.vehicleNumber} — queuing bot now`);
    jobQueue.enqueue(() =>
      _runBot(driverId, state).catch((err) => {
        state.state      = 'watching';
        state.hasBeenSeen = false;
        state.lastResult  = { success: false, error: err.message };

        broadcast('requeue_result', {
          driverId,
          driverName:    state.driverName,
          vehicleNumber: state.vehicleNumber,
          result:        { success: false, error: err.message },
          isAuto:        state.isAuto,
        });
        broadcast('driver_state', { driverId, state: snap(state) });
        console.error(`[Monitor] ✗ Re-queue failed #${state.vehicleNumber}: ${err.message}`);
      }),
    );
  };

  if (delayMs > 0) {
    console.log(`[Monitor] ⏳ #${state.vehicleNumber} — waiting ${delayMs / 1000}s for SAN server to settle…`);
    setTimeout(enqueue, delayMs);
  } else {
    enqueue();
  }
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────
// Each attempt gets a fresh AbortSignal so a timed-out attempt doesn't cancel
// the next one. Waits RETRY_DELAYS[attempt] ms before each retry.
async function fetchQueuePage() {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(QUEUE_URL, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (attempt > 0) console.log(`[Monitor] Fetch succeeded on attempt ${attempt + 1}`);
      return res;
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
      if (attempt < RETRY_COUNT - 1) {
        console.warn(`[Monitor] Fetch attempt ${attempt + 1}/${RETRY_COUNT} failed: ${err.message} — retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Core poll tick ──────────────────────────────────────────────────────────
async function poll() {
  if (watches.size === 0) return; // nothing to watch — skip fetch (cost = 0)

  // Daily counter reset at midnight Pacific
  const currentDayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (currentDayPT !== todayPT) {
    todayPT = currentDayPT;
    for (const s of watches.values()) s.requeueCountToday = 0;
    console.log('[Monitor] Daily counters reset for new day');
    broadcast('daily_reset', { date: currentDayPT });
  }

  const t0 = Date.now();
  let html;

  try {
    const res = await fetchQueuePage();
    html = await res.text();
  } catch (err) {
    lastPollStats = { ...lastPollStats, pollAt: new Date(), error: err.message, fetchMs: Date.now() - t0 };
    broadcast('poll_error', { error: err.message });
    console.warn(`[Monitor] Poll failed after ${RETRY_COUNT} attempt(s): ${err.message}`);
    return;
  }

  const fetchMs = Date.now() - t0;
  const { dispatched, waiting } = parseQueue(html);

  lastPollStats = {
    pollAt:       new Date(),
    totalInQueue: dispatched.size + waiting.size,
    dispatched:   dispatched.size,
    waiting:      waiting.size,
    fetchMs,
    queueUrl:     QUEUE_URL,
    error:        null,
  };

  broadcast('poll', { ...lastPollStats, operatingHours: { active: isWithinOperatingHours(), startHour: OP_START_HOUR, endHour: OP_END_HOUR } });

  // One pass — O(n) with n = number of watches; each lookup is O(1) Map op
  for (const [driverId, state] of watches) {
    if (state.state === 'requeuing') continue; // bot in-flight — skip this driver

    const vn           = state.vehicleNorm;
    const inDispatched = dispatched.has(vn);
    const inWaiting    = waiting.has(vn);
    const prev         = state.state;
    let   next         = prev;

    // Always update live position from the queue page on every tick
    const livePosition = waiting.get(vn) ?? dispatched.get(vn) ?? null;
    if (livePosition !== null) state.currentPosition = livePosition;

    if (inDispatched) {
      if (!state.hasBeenSeen) state.hasBeenSeen = true;
      state.lastSeenAt = new Date();
      if (prev !== 'dispatched') state.lastDispatchAt = new Date();
      next = 'dispatched';
    } else if (inWaiting) {
      if (!state.hasBeenSeen) state.hasBeenSeen = true;
      state.lastSeenAt = new Date();
      next = 'in_queue';
    } else if (state.hasBeenSeen) {
      if (prev !== 'gone') state.lastGoneAt = new Date();
      next = 'gone';
    }
    // !hasBeenSeen + not found → stay 'watching' (not yet queued today)

    const posChanged  = livePosition !== null && livePosition !== state._lastBroadcastPos;
    const stateChanged = next !== prev;

    if (stateChanged) {
      state.state = next;
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} ${prev} → ${next}${livePosition ? ` (pos #${livePosition})` : ''}`);

      if (next === 'gone') {
        if (!isWithinOperatingHours()) {
          console.log(`[Monitor] #${state.vehicleNumber} gone — outside operating hours (${OP_START_HOUR}:00–${OP_END_HOUR}:00 PT), requeue paused`);
        } else {
          triggerRequeue(driverId, state, { delayMs: AUTO_REQUEUE_DELAY_MS }).catch(console.error);
        }
      }
    } else if (posChanged) {
      // Position changed but state didn't — broadcast update so UI stays accurate
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} pos → #${livePosition} (${state.state})`);
    } else if (state.state === 'gone' && isWithinOperatingHours()) {
      // Driver is STILL gone from a previous poll — trigger requeue immediately.
      // The hasBeenSeen=false reset after each bot run prevents loops naturally.
      triggerRequeue(driverId, state, { delayMs: AUTO_REQUEUE_DELAY_MS }).catch(console.error);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a single driver to the watch list.
 * isAuto = true → auto-managed (active driver); false → manual watch.
 * Bootstraps hasBeenSeen from today's logs to preserve context on restart.
 */
async function addWatch(driverId, { isAuto = false } = {}) {
  if (watches.has(driverId)) {
    const existing = watches.get(driverId);
    if (isAuto) {
      existing.isAuto = true;
      autoDriverIds.add(driverId);
    } else {
      // Manual add of an already-watched (auto) driver — pin it to Monitor page.
      // Re-emit watch_added so the Monitor page card appears even though the
      // driver is already in the watches Map from auto-loading.
      manualWatchIds.add(driverId);
      broadcast('watch_added', { driverId, state: snap(existing) });
    }
    return snap(existing);
  }

  const driver = await Driver.findById(driverId);
  if (!driver) throw new Error(`Driver ${driverId} not found`);

  const today   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const lastLog = await Log.findTodayLatest(driverId, today);
  const hasBeenSeen = !!(lastLog && ['success', 'already_queued'].includes(lastLog.status));

  const todayLogs = await Log.findTodayMonitorRequeues(driverId, today);
  const requeueCountToday = todayLogs ? parseInt(todayLogs.count, 10) : 0;

  const state = {
    driverId,
    driverName:        driver.name,
    vehicleNumber:     driver.vehicle_number,
    vehicleNorm:       norm(driver.vehicle_number),
    isAuto,
    state:             hasBeenSeen ? 'in_queue' : 'watching',
    hasBeenSeen,
    addedAt:           new Date(),
    lastSeenAt:        null,
    lastDispatchAt:    null,
    lastGoneAt:        null,
    lastRequeuedAt:    null,
    lastResult:        null,
    requeueCount:       0,
    requeueCountToday,
    currentPosition:    null,  // live position updated every poll tick
    lastPosition:       null,  // position bot placed them at (from bot result)
    _lastBroadcastPos:  null,  // internal: avoids redundant SSE on same position
  };

  watches.set(driverId, state);
  if (isAuto)  autoDriverIds.add(driverId);
  else         manualWatchIds.add(driverId);

  broadcast('watch_added', { driverId, state: snap(state) });
  console.log(`[Monitor] Watching #${driver.vehicle_number} (id=${driverId}, auto=${isAuto}, hasBeenSeen=${hasBeenSeen})`);

  return snap(state);
}

/**
 * Remove a driver from the manual watch list.
 * If they are also auto-watched, they stay in the watches Map (Watchlist still
 * shows them) — only the Monitor page card is removed.
 */
function removeWatch(driverId) {
  const state = watches.get(driverId);
  if (!state) return false;

  manualWatchIds.delete(driverId);

  if (autoDriverIds.has(driverId)) {
    // Still auto-watched — keep in the watches Map, just remove the Monitor card
    broadcast('watch_removed', { driverId, vehicleNumber: state.vehicleNumber });
    console.log(`[Monitor] Unpinned #${state.vehicleNumber} from Monitor (still auto-watched)`);
  } else {
    watches.delete(driverId);
    broadcast('watch_removed', { driverId, vehicleNumber: state.vehicleNumber });
    console.log(`[Monitor] Stopped watching #${state.vehicleNumber}`);
  }
  return true;
}

/**
 * Auto-watch ALL currently active drivers.
 * Called once on startup; also re-called by refreshAutoWatches().
 */
async function watchAllActive() {
  const drivers = await Driver.findAllActive();
  let added = 0;
  for (const d of drivers) {
    if (!watches.has(d.id)) {
      await addWatch(d.id, { isAuto: true }).catch((e) =>
        console.warn(`[Monitor] Skip auto-watch for #${d.vehicle_number}:`, e.message),
      );
      added++;
    }
    // Restore manual Monitor-page pin from DB (survives server restarts).
    // monitor_enabled is set true when admin clicks "Watch Vehicle".
    if (d.monitor_enabled && !manualWatchIds.has(d.id)) {
      manualWatchIds.add(d.id);
      console.log(`[Monitor] Restored manual pin for #${d.vehicle_number}`);
    }
  }
  return added;
}

/**
 * Periodic sync: pick up newly activated drivers, remove deactivated ones.
 * Runs every AUTO_REFRESH_MS (default 5 min) so new drivers are auto-added
 * without a server restart.
 */
async function refreshAutoWatches() {
  try {
    const drivers   = await Driver.findAllActive();
    const activeIds = new Set(drivers.map((d) => d.id));

    // Add any new active drivers
    let added = 0;
    for (const d of drivers) {
      if (!watches.has(d.id)) {
        await addWatch(d.id, { isAuto: true }).catch((e) =>
          console.warn(`[Monitor] Refresh skip #${d.vehicle_number}:`, e.message),
        );
        added++;
      }
    }

    // Remove auto-watches for drivers who are no longer active.
    // If they were also manually pinned, keep them in watches but clear the auto flag.
    let removed = 0;
    for (const driverId of [...autoDriverIds]) {
      if (!activeIds.has(driverId)) {
        autoDriverIds.delete(driverId);
        if (manualWatchIds.has(driverId)) {
          // Keep in watches — still manually pinned on Monitor page
          const s = watches.get(driverId);
          if (s) s.isAuto = false;
        } else {
          const s = watches.get(driverId);
          watches.delete(driverId);
          if (s) broadcast('watch_removed', { driverId, vehicleNumber: s.vehicleNumber });
        }
        removed++;
      }
    }

    if (added || removed) {
      console.log(`[Monitor] Auto-refresh: +${added} added, -${removed} removed (${watches.size} total)`);
    }
  } catch (e) {
    console.warn('[Monitor] Auto-refresh failed:', e.message);
  }
}

/**
 * Manually trigger the bot for a watched driver (the "Run" button).
 * Works regardless of current queue state.
 */
async function manualRun(driverId) {
  const state = watches.get(driverId);
  if (!state) throw new Error('Driver not in watch list');
  if (state.state === 'requeuing') throw new Error('Bot is already running for this driver');

  console.log(`[Monitor] Manual run triggered for #${state.vehicleNumber}`);
  return triggerRequeue(driverId, state);
}

/** Current snapshot — returned to new SSE clients and REST callers. */
function getState() {
  return {
    pollStats:        lastPollStats,
    pollIntervalMs:   POLL_INTERVAL_MS,
    queueUrl:         QUEUE_URL,
    watches:          [...watches.values()].map(snap),
    jobQueue: {
      active:  jobQueue.activeCount,
      pending: jobQueue.pendingCount,
    },
    operatingHours: {
      active:     isWithinOperatingHours(),
      startHour:  OP_START_HOUR,
      endHour:    OP_END_HOUR,
    },
  };
}

/** Aggregate stats snapshot (for the Watchlist stats bar). */
function getStats() {
  const all = [...watches.values()];
  return {
    total:             all.length,
    watching:          all.filter((s) => s.state === 'watching').length,
    inQueue:           all.filter((s) => s.state === 'in_queue').length,
    dispatched:        all.filter((s) => s.state === 'dispatched').length,
    gone:              all.filter((s) => s.state === 'gone').length,
    requeuing:         all.filter((s) => s.state === 'requeuing').length,
    requeuedToday:     all.reduce((n, s) => n + s.requeueCountToday, 0),
    successToday:      all.filter((s) => s.lastResult?.success && s.requeueCountToday > 0).length,
    jobQueue: {
      active:  jobQueue.activeCount,
      pending: jobQueue.pendingCount,
    },
    operatingHours: {
      active:     isWithinOperatingHours(),
      startHour:  OP_START_HOUR,
      endHour:    OP_END_HOUR,
    },
  };
}

/** Register a callback for all monitor events (SSE streams). Returns unsubscribe fn. */
function subscribe(callback) {
  emitter.on('event', callback);
  return () => emitter.off('event', callback);
}

/**
 * Bootstrap on server start:
 *   1. Auto-watch ALL active drivers.
 *   2. Start the poll interval.
 *   3. Start the auto-refresh interval (picks up new drivers every 5 min).
 *   4. Fire one immediate poll so the UI has data right away.
 */
async function startMonitor() {
  // Auto-watch all active drivers first
  try {
    const added = await watchAllActive();
    console.log(`[Monitor] Auto-watched ${added} active driver(s)`);
  } catch (e) {
    console.warn('[Monitor] Initial auto-watch failed:', e.message);
  }

  if (pollTimer)    clearInterval(pollTimer);
  if (refreshTimer) clearInterval(refreshTimer);

  pollTimer    = setInterval(() => poll().catch(console.error),                POLL_INTERVAL_MS);
  refreshTimer = setInterval(() => refreshAutoWatches().catch(console.error),  AUTO_REFRESH_MS);

  poll().catch(console.error); // immediate first tick

  console.log(
    `[Monitor] Started — poll every ${POLL_INTERVAL_MS / 1000}s, ` +
    `auto-refresh every ${AUTO_REFRESH_MS / 1000}s, ` +
    `bot concurrency: ${BOT_CONCURRENCY}, ` +
    `watching ${watches.size} driver(s)`,
  );
}

function stopMonitor() {
  if (pollTimer)    { clearInterval(pollTimer);    pollTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  watches.clear();
  autoDriverIds.clear();
  manualWatchIds.clear();
}

/** Seconds until next scheduled poll. */
function nextPollIn() { return Math.round(POLL_INTERVAL_MS / 1000); }

module.exports = {
  startMonitor,
  stopMonitor,
  addWatch,
  removeWatch,
  manualRun,
  watchAllActive,
  refreshAutoWatches,
  getState,
  getStats,
  subscribe,
  nextPollIn,
  // Exposed for unit tests
  _parseQueue:              parseQueue,
  _norm:                    norm,
  _isWithinOperatingHours:  isWithinOperatingHours,
};
