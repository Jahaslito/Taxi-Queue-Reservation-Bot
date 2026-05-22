'use strict';

const { fetch: ufetch, ProxyAgent } = require('undici');

// ─── Queue Monitor Service ────────────────────────────────────────────────────
//
// Polls V Holding (10-17), T1 (10-8), and T2 (10-9) queue pages.
// V Holding is fetched every tick regardless of driver count (O(1) cost).
// T1/T2 are fetched in parallel — only when at least one driver is in the
// at_terminal state (zero cost otherwise).
// State is kept in-memory; DB is written only when the bot actually runs.
//
// Two watch sources:
//   AUTO   — every is_active driver, loaded on start, refreshed every 5 min.
//   MANUAL — added via the Monitor page "Watch Vehicle" button.
//
// State machine per driver:
//
//   watching ──(seen in V Holding)──► in_queue ──(dispatched row)──► dispatched
//      ▲                                                                   │
//      │                                                     (left V Holding)
//      │                                                                   ▼
//      │                                                          at_terminal
//      │                                                    (polling T1 + T2)
//      │                                                                   │
//      │                                                (gone from T1 & T2)│
//      │                                                                   ▼
//      └──────────────────────────────────────────── requeuing ◄───────────
//                                                        │
//                                             (bot done) │
//                                                        ▼
//                                                   watching
//
// Scalability notes:
//   • One V Holding fetch per tick regardless of driver count (O(1) network cost).
//   • T1/T2 fetched in parallel only when at least one driver is at_terminal.
//   • O(n) in-memory state-machine pass with cheap Set lookups.
//   • Bot jobs are concurrency-capped (MONITOR_CONCURRENCY, default 3).
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
// Auto-requeue fires between REQUEUE_START and REQUEUE_END (8 AM–11 PM PT).
// Position schedule fires between POS_START and POS_END (4 AM–11 PM PT).
// Manual runs via the Run button are never gated by either window.
const OP_START_HOUR  = parseInt(process.env.MONITOR_START_HOUR     ?? '5',  10); //  5 AM PT
const OP_END_HOUR    = parseInt(process.env.MONITOR_END_HOUR       ?? '23', 10); // 11 PM PT
const POS_START_HOUR   = parseInt(process.env.MONITOR_POS_START_HOUR   ?? '3',  10); //  3 AM PT
const POS_END_HOUR     = parseInt(process.env.MONITOR_POS_END_HOUR     ?? '23', 10); // 11 PM PT
// Minimum lead buffer (positions). Small safety cushion for near-zero growth days.
// The dynamic drift calculation takes over whenever growth exceeds ~10 drivers/tick.
const POS_LEAD_BUFFER  = parseInt(process.env.MONITOR_POS_LEAD_BUFFER  ?? '5', 10);
// Estimated Playwright bot execution time (ms). Used to project how many positions
// will be added between the fire decision and when SAN assigns the queue slot.
const POS_BOT_EXEC_MS  = parseInt(process.env.MONITOR_POS_BOT_EXEC_MS  ?? '45000', 10);

function currentHourPT() {
  return parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour:     'numeric',
      hour12:   false,
    }),
    10,
  );
}

function isWithinOperatingHours() {
  const h = currentHourPT();
  return h >= OP_START_HOUR && h < OP_END_HOUR;
}

function isWithinPositionHours() {
  const h = currentHourPT();
  return h >= POS_START_HOUR && h < POS_END_HOUR;
}

const QUEUE_URL = process.env.MONITOR_QUEUE_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-17';
const T1_URL = process.env.MONITOR_T1_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-8';
const T2_URL = process.env.MONITOR_T2_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-9';

// After this many terminal polls with no sighting, requeue anyway.
// Guards against fast dispatches the poll may have missed entirely.
const MAX_TERMINAL_CHECKS = parseInt(process.env.MONITOR_MAX_TERMINAL_CHECKS ?? '5', 10);

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Proxy dispatcher for polling fetches ─────────────────────────────────────
// Shares the same PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD env vars as the
// Playwright bot so all three SAN interactions go through the same proxy.
// Uses a single sticky session for polling (we want a consistent IP, not rotation).
// If PROXY_SERVER is not set, falls back to the server's own IP (no proxy).
function buildPollDispatcher() {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined; // no proxy configured — use direct connection

  const user = (process.env.PROXY_USERNAME || '').replace('{session}', 'monitor-poll');
  const pass = process.env.PROXY_PASSWORD || '';

  // Embed credentials into the proxy URL so undici ProxyAgent can authenticate.
  // Format: http://user:pass@host:port  (works for HTTP CONNECT tunnelling)
  let proxyUrl;
  try {
    const u = new URL(server);
    if (user) { u.username = user; u.password = pass; }
    proxyUrl = u.toString();
  } catch {
    proxyUrl = server; // already has creds embedded, or plain host
  }

  console.log('[Monitor] Proxy enabled for polling →', new URL(proxyUrl).host);
  return new ProxyAgent(proxyUrl);
}

const pollDispatcher = buildPollDispatcher();

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
 *   state:             'watching'|'in_queue'|'dispatched'|'at_terminal'|'requeuing'
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
 *   atTerminalSince:   Date|null  — when driver left V Holding
 *   terminalSeen:      boolean    — true once spotted on T1 or T2
 *   terminalCheckCount:number     — polls elapsed while at_terminal
 *   terminalName:      'T1'|'T2'|null  — which terminal they're at
 *   terminalPosition:  number|null     — their position in that list
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

// ─── Queue growth-rate tracking (for dynamic position-schedule lead) ──────────
// prevWaitingCount: null on startup so the first tick doesn't produce a false surge.
// smoothedGrowthRate: exponential moving average (alpha=0.5) of per-tick deltas.
// Both are global to the queue — one computation per poll tick, shared by all drivers.
let prevWaitingCount  = null;
let smoothedGrowthRate = 0;

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
  const dispatched    = new Map(); // vehicleId → position number
  const waiting       = new Map(); // vehicleId → position number
  const notAuthorized = new Set(); // vehicleIds in the red "not authorized" zone

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

    if (cls === 'notauthorized')    notAuthorized.add(vehicleId);
    else if (cls === 'holdingdispatched') dispatched.set(vehicleId, position);
    else                             waiting.set(vehicleId, position);
  }

  return { dispatched, waiting, notAuthorized };
}

/**
 * Parse a terminal (T1 or T2) dispatch list into a Map of normalised vehicleId → position.
 * Terminal pages have no explicit position column — order is arrival time (first row = #1).
 * Row format: <td font-weight:bold>VEHICLE</td><td>TIME</td><td>SR</td><td>TERMINAL</td>
 */
function parseTerminalPage(html) {
  const vehicles = new Map(); // vehicleId → 1-based position
  const chunks = html.split('<tr');
  let position = 0;
  for (let i = 1; i < chunks.length; i++) {
    const chunk    = chunks[i];
    const boldIdx  = chunk.indexOf('font-weight:bold');
    if (boldIdx === -1) continue;
    position++;
    const valStart = chunk.indexOf('>', boldIdx) + 1;
    const valEnd   = chunk.indexOf('<', valStart);
    if (valStart <= 0 || valEnd <= valStart) continue;
    const vehicleId = norm(chunk.slice(valStart, valEnd));
    if (vehicleId) vehicles.set(vehicleId, position);
  }
  return vehicles;
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
    requeueCount:       state.requeueCount,
    requeueCountToday:  state.requeueCountToday,
    scheduledPosition:  state.scheduledPosition,
    dayPositions:       state.dayPositions,
    positionFiredToday: state.positionFiredToday,
    currentPosition:    state.currentPosition,   // live position from last poll
    lastPosition:       state.lastPosition,       // position bot placed them at
    atTerminalSince:    state.atTerminalSince,
    terminalSeen:       state.terminalSeen,
    terminalCheckCount: state.terminalCheckCount,
    terminalName:       state.terminalName,
    terminalPosition:   state.terminalPosition,
  };
}

// ─── Re-queue trigger (used by auto-detection & manual run) ──────────────────
async function _runBot(driverId, state, triggerType = 'monitor_requeue') {
  // Lazy-require to break circular dependency (monitorService ← schedulerService).
  const { runBotForDriver } = require('./schedulerService');

  const driver = await Driver.findByIdWithCredentials(driverId);
  if (!driver || !driver.is_active) throw new Error('Driver not found or inactive');

  const result = await runBotForDriver(driver, triggerType);

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

  const tag       = triggerType === 'position_schedule' ? '[Pos]' : '[Monitor]';
  const logSuffix = result?.success ? `pos #${result.position}` : `failed — ${result?.error || result?.message || 'unknown'}`;
  console.log(`${tag} ✓ #${state.vehicleNumber} → ${logSuffix}`);
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

// ─── Position-schedule trigger ───────────────────────────────────────────────
// Fires when the live queue waiting count reaches the driver's target - 3.
// No delay before the bot — unlike auto-requeue this is an initial add, not a
// re-add after dispatch, so the SAN server is always ready to accept it.
// positionFiredToday is set BEFORE enqueuing so concurrent polls cannot
// double-trigger the same driver.
async function triggerPositionSchedule(driverId, state, effectivePosition) {
  state.state          = 'requeuing';
  state.lastRequeuedAt = new Date();
  broadcast('driver_state',      { driverId, state: snap(state) });
  broadcast('requeue_triggered', { driverId, vehicleNumber: state.vehicleNumber });

  console.log(`[Pos] 📍 Bot queued for #${state.vehicleNumber} — target: ${effectivePosition}, queue now: ${state._lastQueueSize ?? '?'}`);

  jobQueue.enqueue(() =>
    _runBot(driverId, state, 'position_schedule').catch((err) => {
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
      console.error(`[Monitor] ✗ Position trigger failed #${state.vehicleNumber}: ${err.message}`);
    }),
  );
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────
// Each attempt gets a fresh AbortSignal so a timed-out attempt doesn't cancel
// the next one. Waits RETRY_DELAYS[attempt] ms before each retry.
async function fetchPage(url) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      const res = await ufetch(url, {
        headers:    { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal:     AbortSignal.timeout(FETCH_TIMEOUT),
        dispatcher: pollDispatcher, // undefined = direct (no proxy); ProxyAgent = routed
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (attempt > 0) console.log(`[Monitor] Fetch succeeded on attempt ${attempt + 1} (${url})`);
      return res;
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
      if (attempt < RETRY_COUNT - 1) {
        console.warn(`[Monitor] Fetch attempt ${attempt + 1}/${RETRY_COUNT} failed (${url}): ${err.message} — retrying in ${delay / 1000}s`);
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
    for (const s of watches.values()) {
      s.requeueCountToday  = 0;
      s.positionFiredToday = false;
    }
    console.log('[Monitor] Daily counters reset for new day');
    broadcast('daily_reset', { date: currentDayPT });
  }

  const t0 = Date.now();
  let html;

  try {
    const res = await fetchPage(QUEUE_URL);
    html = await res.text();
  } catch (err) {
    lastPollStats = { ...lastPollStats, pollAt: new Date(), error: err.message, fetchMs: Date.now() - t0 };
    broadcast('poll_error', { error: err.message });
    console.warn(`[Monitor] Poll failed after ${RETRY_COUNT} attempt(s): ${err.message}`);
    return;
  }

  const fetchMs = Date.now() - t0;
  const { dispatched, waiting, notAuthorized } = parseQueue(html);

  lastPollStats = {
    pollAt:       new Date(),
    totalInQueue: dispatched.size + waiting.size,
    dispatched:   dispatched.size,
    waiting:      waiting.size,
    fetchMs,
    queueUrl:     QUEUE_URL,
    error:        null,
  };

  broadcast('poll', {
    ...lastPollStats,
    operatingHours:  { active: isWithinOperatingHours(),  startHour: OP_START_HOUR,  endHour: OP_END_HOUR  },
    positionHours:   { active: isWithinPositionHours(),   startHour: POS_START_HOUR, endHour: POS_END_HOUR },
  });

  const waitingCount = waiting.size;

  // ─── Queue growth rate (used by position-schedule lead calculation) ──────────
  // rawGrowth: how many drivers joined since the last poll tick.
  // smoothedGrowthRate: EMA (α=0.5) — dampens noise while staying reactive.
  // effectiveGrowthRate: max(raw, smoothed) — catches single-tick surges immediately.
  // prevWaitingCount is null on first tick → skip to avoid a false 0→N spike.
  let effectiveGrowthRate = 0;
  if (prevWaitingCount !== null) {
    const rawGrowth = Math.max(0, waitingCount - prevWaitingCount);
    smoothedGrowthRate = smoothedGrowthRate * 0.5 + rawGrowth * 0.5;
    effectiveGrowthRate = Math.max(rawGrowth, smoothedGrowthRate);
  }
  prevWaitingCount = waitingCount;

  // One pass — O(n) with n = number of watches; each lookup is O(1) Map op
  const returnedFromTerminal = []; // drivers SAN auto-returned to V Holding mid-terminal

  for (const [driverId, state] of watches) {
    state._lastQueueSize = waitingCount; // keep fresh for logging

    if (state.state === 'requeuing') continue; // bot in-flight — skip this driver

    const vn              = state.vehicleNorm;
    const inDispatched    = dispatched.has(vn);
    const inWaiting       = waiting.has(vn);
    const inNotAuthorized = notAuthorized.has(vn);
    const prev            = state.state;
    let   next            = prev;

    // Always update live position from the queue page on every tick
    const livePosition = waiting.get(vn) ?? dispatched.get(vn) ?? null;
    if (livePosition !== null) state.currentPosition = livePosition;

    if (inNotAuthorized) {
      // Driver is in the red "not authorized" zone — visible but blocked by SAN.
      // Do NOT set hasBeenSeen (they haven't earned a queue spot) and do NOT requeue.
      next = 'not_authorized';
    } else if (inDispatched) {
      if (!state.hasBeenSeen) state.hasBeenSeen = true;
      state.lastSeenAt = new Date();
      if (prev !== 'dispatched') state.lastDispatchAt = new Date();
      next = 'dispatched';
    } else if (inWaiting) {
      if (!state.hasBeenSeen) state.hasBeenSeen = true;
      state.lastSeenAt = new Date();
      // If transitioning from at_terminal → in_queue, SAN auto-returned the driver
      // to V Holding before the terminal poll could detect they'd left. Collect for
      // requeue below (after the stateChanged broadcast fires) so we don't double-emit.
      if (prev === 'at_terminal') {
        returnedFromTerminal.push({ driverId, state });
      }
      next = 'in_queue';
    } else if (state.hasBeenSeen) {
      // Driver was seen in V Holding but is no longer there — they've been
      // dispatched to a terminal. Enter at_terminal and let the terminal poll
      // below decide when to requeue.
      if (prev !== 'at_terminal') {
        state.lastGoneAt         = new Date();
        state.atTerminalSince    = new Date();
        state.terminalSeen       = false;
        state.terminalCheckCount = 0;
        state.terminalName       = null;
        state.terminalPosition   = null;
      }
      next = 'at_terminal';
    }
    // !hasBeenSeen + not found → stay 'watching' (not yet queued today)

    const posChanged   = livePosition !== null && livePosition !== state._lastBroadcastPos;
    const stateChanged = next !== prev;

    if (stateChanged) {
      state.state = next;
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} ${prev} → ${next}${livePosition ? ` (pos #${livePosition})` : ''}`);
    } else if (posChanged) {
      // Position changed but state didn't — broadcast update so UI stays accurate
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} pos → #${livePosition} (${state.state})`);
    }
  }

  // ─── Requeue drivers SAN auto-returned to V Holding during terminal service ──
  // When a driver finishes a terminal trip, SAN sometimes places them back in
  // V Holding before our next poll detects their absence from T1/T2. The V Holding
  // loop above flags them; we fire the bot here (after the stateChanged broadcast)
  // so the event is logged and the UI shows the re-queue attempt.
  for (const { driverId, state } of returnedFromTerminal) {
    if (!isWithinOperatingHours()) {
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — outside operating hours ` +
        `(${OP_START_HOUR}:00–${OP_END_HOUR}:00 PT), requeue paused`,
      );
    } else {
      console.log(
        `[Monitor] #${state.vehicleNumber} at_terminal → in_queue (SAN auto-returned, ` +
        `pos #${state.currentPosition}) — firing requeue`,
      );
      triggerRequeue(driverId, state).catch(console.error);
    }
  }

  // ─── Terminal poll ────────────────────────────────────────────────────────
  // Fetch T1 + T2 in parallel — only when at least one driver is at_terminal.
  // Cost is zero when no drivers are waiting to clear a terminal.
  const atTerminalDrivers = [...watches.entries()]
    .filter(([, s]) => s.state === 'at_terminal');

  if (atTerminalDrivers.length > 0) {
    let t1Vehicles = new Set();
    let t2Vehicles = new Set();

    const [t1Result, t2Result] = await Promise.allSettled([
      fetchPage(T1_URL).then((r) => r.text()),
      fetchPage(T2_URL).then((r) => r.text()),
    ]);

    if (t1Result.status === 'fulfilled') {
      t1Vehicles = parseTerminalPage(t1Result.value);
    } else {
      console.warn(`[Monitor] T1 fetch failed: ${t1Result.reason?.message}`);
    }
    if (t2Result.status === 'fulfilled') {
      t2Vehicles = parseTerminalPage(t2Result.value);
    } else {
      console.warn(`[Monitor] T2 fetch failed: ${t2Result.reason?.message}`);
    }

    for (const [driverId, state] of atTerminalDrivers) {
      if (state.state === 'requeuing') continue;

      const vn            = state.vehicleNorm;
      const t1Pos         = t1Vehicles.get(vn) ?? null;
      const t2Pos         = t2Vehicles.get(vn) ?? null;
      const onAnyTerminal = t1Pos !== null || t2Pos !== null;

      if (onAnyTerminal) {
        const which    = t1Pos !== null ? 'T1' : 'T2';
        const termPos  = t1Pos ?? t2Pos;
        const changed  = !state.terminalSeen
          || state.terminalName !== which
          || state.terminalPosition !== termPos;

        state.terminalSeen     = true;
        state.terminalName     = which;
        state.terminalPosition = termPos;

        if (changed) {
          console.log(`[Monitor] #${state.vehicleNumber} → at ${which} terminal (pos #${termPos})`);
          broadcast('driver_state', { driverId, state: snap(state) });
        }
        // Still at terminal — keep watching
      } else {
        // Not found on either terminal this poll
        state.terminalCheckCount++;

        const clearedAfterSeen  = state.terminalSeen;
        const timedOut          = state.terminalCheckCount >= MAX_TERMINAL_CHECKS;

        if (clearedAfterSeen || timedOut) {
          if (!isWithinOperatingHours()) {
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — outside operating hours ` +
              `(${OP_START_HOUR}:00–${OP_END_HOUR}:00 PT), requeue paused`,
            );
          } else {
            const reason = clearedAfterSeen
              ? 'left terminal list'
              : `not seen on terminals after ${MAX_TERMINAL_CHECKS} checks`;
            console.log(`[Monitor] #${state.vehicleNumber} → ${reason} — requeueing now`);
            // No delay: driver has fully cleared both V Holding and terminal
            triggerRequeue(driverId, state).catch(console.error);
          }
        } else {
          console.log(
            `[Monitor] #${state.vehicleNumber} not on terminals yet ` +
            `(check ${state.terminalCheckCount}/${MAX_TERMINAL_CHECKS})`,
          );
        }
      }
    }
  }

  // ─── Position schedule check ─────────────────────────────────────────────────
  // Only runs within the position operating window (3 AM–11 PM PT).
  // positionFiredToday is set synchronously before enqueuing — so if 10 drivers all
  // share the same target, each gets triggered exactly once even within this loop.
  // positionFiredToday also survives queue resets: once fired it stays true for
  // the rest of the day regardless of what happens to the queue.
  //
  // Dynamic lead: estimatedDrift = effectiveGrowthRate × (poll_staleness + bot_exec_time) / poll_interval
  // The +1 term accounts for poll staleness: the snapshot we're reading may already be up to
  // one full poll interval (90 s) old before the bot even starts. Adding 1.0 to the fraction
  // means we project drift across both the staleness window AND the bot execution window.
  //   botTimeFraction = (45 000 / 90 000) + 1.0 = 1.5  →  1.5 poll-intervals of growth covered
  // The hard floor of 20 ensures the bot fires early enough on calm days even when growth ≈ 0,
  // preventing systematic undershoots like 115→187 seen on surge mornings.
  if (isWithinPositionHours()) {
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const DAY_KEY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const todayDayKey = DAY_KEY_MAP[todayDayStr];

  const botTimeFraction  = (POS_BOT_EXEC_MS / POLL_INTERVAL_MS) + 1; // +1 covers poll-staleness window
  const estimatedDrift   = Math.max(20, Math.ceil(effectiveGrowthRate * botTimeFraction));

  for (const [driverId, state] of watches) {
    // Resolve today's effective position — skips drivers with no target today
    let effectivePosition = state.scheduledPosition;
    if (state.dayPositions) {
      try {
        const dp = JSON.parse(state.dayPositions);
        effectivePosition = dp[todayDayKey] ?? null;
      } catch { effectivePosition = null; }
    }
    if (!effectivePosition) continue; // no position target today

    if (state.positionFiredToday) {
      console.log(`[Pos] #${state.vehicleNumber} — already fired today (target: ${effectivePosition}), skipping`);
      continue;
    }
    if (state.state === 'requeuing') {
      console.log(`[Pos] #${state.vehicleNumber} — bot in-flight, skipping`);
      continue;
    }
    if (state.hasBeenSeen) {
      console.log(`[Pos] #${state.vehicleNumber} — already in queue today, skipping`);
      continue;
    }

    // Fire when projected landing position (queue + drift during bot run) hits target
    const projectedLanding = waitingCount + estimatedDrift;
    if (projectedLanding >= effectivePosition) {
      console.log(
        `[Pos] #${state.vehicleNumber} — ✓ queue ${waitingCount} + drift ${estimatedDrift} ` +
        `= ${projectedLanding} ≥ ${effectivePosition} (growth: ${Math.round(effectiveGrowthRate)}/tick) — firing bot`,
      );
      state.positionFiredToday = true; // mark before enqueuing — prevents double-trigger
      triggerPositionSchedule(driverId, state, effectivePosition).catch(console.error);
    } else {
      console.log(
        `[Pos] #${state.vehicleNumber} — waiting ` +
        `(queue: ${waitingCount}, drift: ${estimatedDrift}, projected: ${projectedLanding}, target: ${effectivePosition})`,
      );
    }
  }
  } // end isWithinPositionHours
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a single driver to the watch list.
 * isAuto = true → auto-managed (active driver); false → manual watch.
 * Bootstraps hasBeenSeen from today's logs to preserve context on restart.
 */
// _ctx is an optional pre-loaded batch context from Log.loadTodayContext().
// When provided, all three per-driver DB queries are skipped — Map lookups only.
async function addWatch(driverId, { isAuto = false, _ctx = null } = {}) {
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

  const driver = _ctx?.driverById?.get(driverId) ?? await Driver.findById(driverId);
  if (!driver) throw new Error(`Driver ${driverId} not found`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  let lastLog, requeueCountToday, positionFiredToday;
  if (_ctx) {
    const latestLog = _ctx.latestByDriver.get(driverId) ?? null;
    lastLog             = latestLog;
    requeueCountToday   = _ctx.requeueCountByDriver.get(driverId) ?? 0;
    const hasPosSched   = !!(driver.scheduled_position || driver.day_positions);
    positionFiredToday  = hasPosSched ? !!_ctx.positionLogByDriver.get(driverId) : false;
  } else {
    lastLog = await Log.findTodayLatest(driverId, today);
    const todayLogs   = await Log.findTodayMonitorRequeues(driverId, today);
    requeueCountToday = todayLogs ? parseInt(todayLogs.count, 10) : 0;
    const hasPosSched = !!(driver.scheduled_position || driver.day_positions);
    const positionLog = hasPosSched
      ? await Log.findTodayByTriggerType(driverId, 'position_schedule', today)
      : null;
    positionFiredToday = !!positionLog;
  }

  const hasBeenSeen = !!(lastLog && ['success', 'already_queued'].includes(lastLog.status));

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
    scheduledPosition:  driver.scheduled_position ?? null,
    dayPositions:       driver.day_positions ?? null,
    positionFiredToday,
    currentPosition:    null,  // live position updated every poll tick
    lastPosition:       null,  // position bot placed them at (from bot result)
    atTerminalSince:    null,
    terminalSeen:       false,
    terminalCheckCount: 0,
    terminalName:       null,
    terminalPosition:   null,
    _lastBroadcastPos:  null,  // internal: avoids redundant SSE on same position
    _lastQueueSize:     null,  // internal: queue size at last poll (for logging)
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
  if (!drivers.length) return 0;

  // Batch-load today's log context for all drivers in 3 parallel queries
  // instead of 3 × N sequential queries. Cuts startup from O(N) round-trips
  // down to O(1) regardless of driver count.
  const today      = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const newIds     = drivers.filter((d) => !watches.has(d.id)).map((d) => d.id);
  const logCtx     = await Log.loadTodayContext(newIds, today);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const ctx        = { ...logCtx, driverById };

  let added = 0;
  for (const d of drivers) {
    if (!watches.has(d.id)) {
      await addWatch(d.id, { isAuto: true, _ctx: ctx }).catch((e) =>
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

    // Add any new active drivers; update scheduling fields for existing ones
    let added = 0;
    for (const d of drivers) {
      if (!watches.has(d.id)) {
        await addWatch(d.id, { isAuto: true }).catch((e) =>
          console.warn(`[Monitor] Refresh skip #${d.vehicle_number}:`, e.message),
        );
        added++;
      } else {
        // Sync position schedule fields so driver profile changes take effect within 5 min
        const existing = watches.get(d.id);
        existing.scheduledPosition = d.scheduled_position ?? null;
        existing.dayPositions      = d.day_positions ?? null;
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
    atTerminal:        all.filter((s) => s.state === 'at_terminal').length,
    gone:              0,
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
  prevWaitingCount   = null;
  smoothedGrowthRate = 0;
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
  _parseTerminalPage:       parseTerminalPage,
  _norm:                    norm,
  _isWithinOperatingHours:  isWithinOperatingHours,
};
