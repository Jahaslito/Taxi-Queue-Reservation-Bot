'use strict';

const fs    = require('fs');
const path  = require('path');
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

const { EventEmitter }    = require('events');
const Driver              = require('../models/Driver');
const Log                 = require('../models/Log');
const PositionTracking    = require('../models/PositionTracking');
const QueueSnapshot       = require('../models/QueueSnapshot');

// ─── Constants (overridable via env for testing / tuning) ────────────────────
// POLL_INTERVAL_MS is the maximum (idle) cadence. Adaptive polling tightens to
// 10 s or 5 s when any position-scheduled driver is close to firing — see
// computeNextPollMs() below. Trade-off: bandwidth vs miss-rate near surge.
const POLL_INTERVAL_MS  = parseInt(process.env.MONITOR_POLL_MS     ?? String(90_000), 10);
const POLL_NEAR_FIRE_MS = parseInt(process.env.MONITOR_POLL_NEAR_FIRE_MS ?? '10000', 10); // <60s away
const POLL_AT_FIRE_MS   = parseInt(process.env.MONITOR_POLL_AT_FIRE_MS   ??  '5000', 10); // <20s away
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
// Floor for the per-tick drift estimate. The old value of 20 was too aggressive
// — it caused systematic over-firing on quiet/flat-queue mornings (drivers
// landing 10-20+ positions BELOW target). 5 keeps a small cushion without
// fabricating growth that isn't there.
const POS_DRIFT_FLOOR  = parseInt(process.env.MONITOR_POS_DRIFT_FLOOR  ?? '5',  10);
// Fallback estimate for Playwright bot execution time (ms) before we have real
// data. Used to project how many positions will be added between the fire decision
// and when SAN assigns the queue slot. The actual estimate is the rolling P95 of
// the last MAX_LATENCY_SAMPLES bot runs (see botExecutionEstimateMs below) — this
// constant is only the cold-start default until we collect enough samples.
const POS_BOT_EXEC_MS  = parseInt(process.env.MONITOR_POS_BOT_EXEC_MS  ?? '15000', 10);
// Minimum assumed queue growth rate (drivers/second) used as a floor before historical
// data exists and during calm periods. Protects against cold-start on a busy morning.
// Tune down if drivers land too early; tune up if they still land too late.
const EMERGENCY_SURGE_RATE = parseFloat(process.env.MONITOR_EMERGENCY_SURGE_RATE ?? '0.5');
// Extra seconds added to the forecast horizon as a safety cushion.
const SAFETY_BUFFER_SECS   = parseInt(process.env.MONITOR_SAFETY_BUFFER_MS ?? '10000', 10) / 1000;
// How many recent queue observations to keep for the short-window rate calculation.
const SHORT_WINDOW_POLLS   = 3;

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
  // Normalise: add http:// if the server value has no protocol.
  const normalised = /^https?:\/\//i.test(server) ? server : `http://${server}`;
  let proxyUrl;
  try {
    const u = new URL(normalised);
    if (user) { u.username = encodeURIComponent(user); u.password = encodeURIComponent(pass); }
    proxyUrl = u.toString();
  } catch {
    proxyUrl = normalised;
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
// All rates are in drivers/second so they stay accurate even if poll intervals drift.
// prevWaitingCount: null on startup so the first tick doesn't produce a false surge.
// smoothedGrowthRate: EMA (α=0.7) of per-second growth rate — reacts fast to surges.
// lastObservationAt: timestamp (ms) when the latest queue snapshot was fetched.
// prevObservationAt: timestamp of the previous snapshot — used to get elapsed seconds.
// biasCorrection: median of recent (actual - target) landing errors, updated periodically.
//   If positive, drivers are landing too far back → added to prediction so bot fires earlier.
// biasPollCount: counts poll ticks to know when to refresh the bias correction.
let prevWaitingCount   = null;
let smoothedGrowthRate = 0;       // drivers/second
let lastObservationAt  = null;    // ms timestamp of latest observation
let prevObservationAt  = null;    // ms timestamp of previous observation
let biasCorrection     = 0;       // positions — loaded from position_tracking history
let biasPollCount      = 0;
const BIAS_REFRESH_EVERY = 20;    // recalculate bias every N poll ticks
// Maximum |bias| we'll apply. Belt to medianRecentError's outlier filter (the
// braces) — bounds the worst-case prediction damage if a contamination path
// we haven't found yet pulls the median to an unhelpful value. 10 positions is
// enough for genuine calibration (real fires consistently land within ±15);
// anything larger is almost certainly bad input data, not real drift.
const BIAS_CAP_POSITIONS = parseInt(process.env.MONITOR_BIAS_CAP ?? '10', 10);
// Circular buffer of recent {count, observedAt} snapshots for short-window rate.
// Oldest entry first; capped at SHORT_WINDOW_POLLS + 1 entries.
const recentObservations = [];

// ─── Adaptive polling (poll faster as drivers approach their fire window) ────
// Current effective interval (ms). Recalculated at the end of every poll based
// on the smallest secondsUntilFire across all armed position-scheduled drivers.
// Lives at module scope so getState() / nextPollIn() can report it.
let currentPollDelayMs = POLL_INTERVAL_MS;

/**
 * Pure function: returns the poll interval (ms) appropriate for a given
 * "seconds until next driver needs to fire". Tighter cadence near the fire
 * window, idle cadence otherwise. Also used by the fire-before-next-poll guard
 * so both decisions stay consistent.
 */
function expectedNextPollMs(secondsUntilFire) {
  if (!Number.isFinite(secondsUntilFire) || secondsUntilFire > 60) return POLL_INTERVAL_MS;
  if (secondsUntilFire > 20) return POLL_NEAR_FIRE_MS;
  return POLL_AT_FIRE_MS;
}

// ─── Bot latency tracking (P95) ──────────────────────────────────────────────
// Ring buffer of recent bot execution times in milliseconds. Used to compute the
// dynamic horizon for drift prediction — replaces the stale 45 s constant from
// before the proxy/session-cache speedups. Lost on restart but converges within
// the first 5+ bot runs of the morning. In-memory only — zero DB cost.
//
// Push is O(1); P95 is O(n log n) for n=30 (~0.01 ms — negligible vs. a 30 s poll).
const MAX_LATENCY_SAMPLES  = 30;
const MIN_SAMPLES_FOR_P95  = 5;
const botLatencySamples    = []; // ms; newest pushed to end, oldest shifted off

// ─── Persistence — survives restarts so cold-start doesn't fall back to the
// 15 s POS_BOT_EXEC_MS default on a busy morning ──────────────────────────────
// Tiny JSON file. Reads once on boot; writes atomically (write-to-temp +
// rename) so a crash mid-write can't corrupt the file. Throttled to one write
// per ~5 s so a burst of bot completions doesn't hammer the disk.
const LATENCY_PERSIST_PATH = process.env.BOT_LATENCY_PERSIST_PATH
  ?? path.join(process.cwd(), 'data', 'bot-latency-samples.json');
const LATENCY_PERSIST_THROTTLE_MS = 5000;
let latencyPersistTimer = null;

function loadBotLatencyFromDisk() {
  try {
    if (!fs.existsSync(LATENCY_PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LATENCY_PERSIST_PATH, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const ms of raw) {
      if (Number.isFinite(ms) && ms > 0 && botLatencySamples.length < MAX_LATENCY_SAMPLES) {
        botLatencySamples.push(ms);
      }
    }
    if (botLatencySamples.length) {
      console.log(`[Monitor] Restored ${botLatencySamples.length} bot-latency samples from disk`);
    }
  } catch (err) {
    console.warn(`[Monitor] Could not load latency samples (${err.message}) — starting fresh`);
  }
}

function schedulePersistBotLatency() {
  if (latencyPersistTimer) return; // already pending
  latencyPersistTimer = setTimeout(() => {
    latencyPersistTimer = null;
    const tmp = `${LATENCY_PERSIST_PATH}.tmp`;
    try {
      fs.mkdirSync(path.dirname(LATENCY_PERSIST_PATH), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(botLatencySamples));
      fs.renameSync(tmp, LATENCY_PERSIST_PATH); // atomic on POSIX
    } catch (err) {
      console.warn(`[Monitor] Could not persist latency samples: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }, LATENCY_PERSIST_THROTTLE_MS).unref();
}

function recordBotLatency(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  botLatencySamples.push(durationMs);
  if (botLatencySamples.length > MAX_LATENCY_SAMPLES) botLatencySamples.shift();
  schedulePersistBotLatency();
}

// Eagerly load on module import so the first poll already has data.
loadBotLatencyFromDisk();

/**
 * Returns the bot execution estimate (ms) used by the drift forecast.
 *   • Fewer than MIN_SAMPLES_FOR_P95 samples → POS_BOT_EXEC_MS env fallback
 *   • Otherwise → P95 of the rolling window (resilient to outliers)
 */
function botExecutionEstimateMs() {
  if (botLatencySamples.length < MIN_SAMPLES_FOR_P95) return POS_BOT_EXEC_MS;
  const sorted = [...botLatencySamples].sort((a, b) => a - b);
  const idx    = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, idx)];
}

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

// ─── Recent requeue events ring buffer (survives page navigations) ───────────
const MAX_RECENT_EVENTS = 50;
const recentRequeuEvents = [];   // newest first

// ─── Position decision recording ─────────────────────────────────────────────
// Writes one row per driver per day to position_tracking, upserted on every
// decision-state CHANGE (not every poll). For ~10 drivers this is ≤30 writes/day
// total — negligible DB load. The in-memory state.lastPosDecision is the de-dupe
// gate so we don't write the same 'waiting' row 120 times an hour.
//
// Fire-state metrics are passed when transitioning to 'fired' (inside
// triggerPositionSchedule), so a single row captures the lifecycle:
//   waiting → fired → completed (or missed/failed).
function recordPositionDecision(state, decision, reason, metrics = {}) {
  if (state.lastPosDecision === decision) return; // no state change → no write
  state.lastPosDecision = decision;

  PositionTracking.upsertDecision({
    driverId:              state.driverId,
    vehicleNumber:         state.vehicleNumber,
    targetPosition:        metrics.targetPosition,
    maxAcceptablePosition: metrics.maxAcceptablePosition,
    decision,
    decisionReason:        reason,
    queueSizeAtFire:       metrics.queueSize,
    growthRate:            metrics.growthRate,
    estimatedDrift:        metrics.estimatedDrift,
    predictedLanding:      metrics.predictedLanding,
    firedAt:               metrics.firedAt,
  }).catch((err) => console.error(
    `[PosTracking] upsert failed for #${state.vehicleNumber}: ${err.message}`,
  ));
}

// ─── SSE broadcast ───────────────────────────────────────────────────────────
function broadcast(type, payload) {
  const ts = Date.now();
  if (type === 'requeue_result') {
    recentRequeuEvents.unshift({ type, payload, ts });
    if (recentRequeuEvents.length > MAX_RECENT_EVENTS) recentRequeuEvents.length = MAX_RECENT_EVENTS;
  }
  emitter.emit('event', { type, payload, ts });
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
    positionFiredToday:    state.positionFiredToday,
    inQueueFromCarryover:  state.inQueueFromCarryover,
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

  // Record execution time for the rolling P95 used by drift prediction.
  // Replaces the stale POS_BOT_EXEC_MS constant — see botExecutionEstimateMs().
  if (Number.isFinite(result?.durationMs)) {
    recordBotLatency(result.durationMs);
    // If this was a position-schedule fire, persist the duration onto the
    // same row that already has the 'fired' decision.
    if (state.pendingTrackingId) {
      PositionTracking.recordBotDuration(state.pendingTrackingId, result.durationMs)
        .catch((err) => console.error('[PosTracking] recordBotDuration error:', err.message));
    }
  }

  state.lastResult  = result;
  state.state       = 'watching';
  // Keep hasBeenSeen=true when the bot succeeded (added or found already in queue).
  // This prevents the position scheduler from firing in the gap between bot
  // completion and the next queue-page fetch — the next poll will confirm in_queue.
  // Only reset to false if the bot actually failed (driver is definitely not in queue).
  state.hasBeenSeen = !!(result?.success);
  if (result?.success && !result?.alreadyQueued) {
    state.requeueCount++;
    state.requeueCountToday++;
  }
  if (result?.position) state.lastPosition = result.position;

  // Record actual_position straight from the bot result rather than waiting
  // for the next poll to see the driver in V Holding. On a busy morning SAN
  // can dispatch a driver out of waiting in under 2 s — faster than the next
  // poll tick — leaving the position_tracking row stuck at decision='fired'
  // forever (the "pending" state in the admin UI). The bot's result.position
  // is SAN-authoritative for the position assigned right after add-to-queue.
  //
  // Critical: a result with alreadyQueued=true means the bot landed on SAN's
  // WAIT screen without adding anyone — the position is whoever else queued
  // the driver (carryover, monitor auto-requeue, driver self-add). Writing
  // that as the position-schedule actual feeds garbage into medianRecentError,
  // which is how bias correction reached −14 on 2026-05-27 and pushed
  // legitimate fires past maxAcceptable. We still write on the
  // recoveredFromTimeout path: there the bot DID attempt the add — only the
  // response timed out — and the position came from a fresh V Holding fetch,
  // not a stale WAIT screen.
  const safeToRecord =
    result?.success
    && Number.isFinite(result.position)
    && (!result.alreadyQueued || result.recoveredFromTimeout);

  if (state.pendingTrackingId && safeToRecord) {
    const trackingId = state.pendingTrackingId;
    state.pendingTrackingId = null;
    PositionTracking.updateActualPosition(trackingId, result.position)
      .then(() => console.log(`[PosTracking] #${state.vehicleNumber} landed at ${result.position} (from bot result)`))
      .catch((err) => console.error('[PosTracking] Failed to update actual position from bot result:', err.message));
  } else if (state.pendingTrackingId && result?.alreadyQueued && !result.recoveredFromTimeout) {
    // Drop pendingTrackingId so the next poll's V-Holding observation doesn't
    // attach a (potentially also stale) actual_position to this row. The 'fired'
    // row stays for visibility but won't get an actual_position — preferable to
    // a wrong one that poisons bias.
    state.pendingTrackingId = null;
    console.log(`[PosTracking] #${state.vehicleNumber} → bot found already in queue (pos ${result.position}) — NOT recording as actual (avoids bias contamination)`);
  }

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
async function triggerPositionSchedule(driverId, state, effectivePosition, {
  growthRate           = 0,
  estimatedDrift       = 0,
  predictedLanding     = null,
  maxAcceptablePosition = null,
} = {}) {
  state.state          = 'requeuing';
  state.lastRequeuedAt = new Date();
  broadcast('driver_state',      { driverId, state: snap(state) });
  broadcast('requeue_triggered', { driverId, vehicleNumber: state.vehicleNumber });

  const queueSizeAtFire = state._lastQueueSize ?? 0;
  console.log(`[Pos] 📍 Bot queued for #${state.vehicleNumber} — target: ${effectivePosition}, queue now: ${queueSizeAtFire}`);

  // Upsert the 'fired' decision — replaces any prior 'waiting' record for today.
  // Non-blocking; we capture pendingTrackingId so the bot result / actual landing
  // can be filled in on the same row later.
  PositionTracking.upsertDecision({
    driverId,
    vehicleNumber:         state.vehicleNumber,
    targetPosition:        effectivePosition,
    maxAcceptablePosition,
    decision:              'fired',
    decisionReason:        'inside_fire_window',
    queueSizeAtFire,
    growthRate,
    estimatedDrift,
    predictedLanding,
    firedAt:               new Date(),
  }).then((trackingId) => {
    state.pendingTrackingId = trackingId;
    state.lastPosDecision   = 'fired';
  }).catch((err) => console.error('[PosTracking] Failed to upsert fired row:', err.message));

  jobQueue.enqueue(() =>
    _runBot(driverId, state, 'position_schedule').catch((err) => {
      state.state      = 'watching';
      state.hasBeenSeen = false;
      state.lastResult  = { success: false, error: err.message };

      // Persist the failure so the report shows it. Clearing pendingTrackingId
      // is critical: without it, the next poll's V Holding observation would
      // overwrite this failed row's actual_position (the driver may still be
      // in queue from an earlier event), masking the failure in the report.
      if (state.pendingTrackingId) {
        const failedTrackingId = state.pendingTrackingId;
        state.pendingTrackingId = null;
        PositionTracking.markFailed(failedTrackingId, err.message)
          .catch((e) => console.error('[PosTracking] markFailed error:', e.message));
        state.lastPosDecision = 'failed';
      }

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

// ─── Position-scheduler decision function ───────────────────────────────────
// Pure function — no side effects, no I/O. Returns a decision object the caller
// applies. Centralising the logic here makes it easy to unit-test and ensures
// the log line, DB write, and bot fire all see the same metrics.
//
// Decision shape:
//   { action: 'skip_no_target'      }                                  // no DB write
//   { action: 'skip_already_fired'  , logLine }                        // no DB write
//   { action: 'skip_bot_inflight'   , reason, logLine, metrics }
//   { action: 'skip_already_seen'   , reason, logLine, metrics }
//   { action: 'fire'                , reason, logLine, fireOpts, ... } // sets positionFiredToday
//   { action: 'wait'                , reason, logLine, metrics, secondsUntilFire }
//   { action: 'missed_impossible'   , reason, logLine, metrics }       // queue already past max
function evaluatePositionScheduler(state, ctx) {
  const {
    waitingCount,
    effectiveGrowthRate,
    estimatedDrift,
    biasCorrection,
    horizonSeconds,
    botExecMs,
    todayDayKey,
    botSamplesCount,
    queueShrinkageDetected = false,
  } = ctx;

  // Resolve today's effective position — skip drivers with no target today
  let effectivePosition = state.scheduledPosition;
  if (state.dayPositions) {
    try {
      const dp = JSON.parse(state.dayPositions);
      effectivePosition = dp[todayDayKey] ?? null;
    } catch { effectivePosition = null; }
  }
  if (!effectivePosition) return { action: 'skip_no_target' };

  // Tolerance ceiling — driver-configured or default (target + 20)
  const maxAcceptable = Number.isInteger(state.maxAcceptablePosition)
    ? state.maxAcceptablePosition
    : effectivePosition + 20;

  const baseMetrics = { targetPosition: effectivePosition, maxAcceptablePosition: maxAcceptable };
  const veh         = `#${state.vehicleNumber}`;

  // ─── Early skip checks ────────────────────────────────────────────────────
  if (state.positionFiredToday) {
    return {
      action:  'skip_already_fired',
      logLine: `[Pos] ${veh} — already fired today (target: ${effectivePosition}), skipping`,
    };
  }
  if (state.state === 'requeuing') {
    return {
      action:  'skip_bot_inflight',
      reason:  'bot_currently_running',
      logLine: `[Pos] ${veh} — bot in-flight, skipping`,
      metrics: baseMetrics,
    };
  }
  // Carryover from yesterday: still in V Holding at midnight rollover. SAN
  // empties V Holding overnight (logs show queue=0 by ~02:00 PT), so we wait
  // for the purge rather than firing now — which would land on SAN's "Already
  // in queue" WAIT screen and record yesterday's position as today's actual.
  // The state machine clears inQueueFromCarryover the first poll the driver
  // is no longer in V Holding, after which this branch stops matching.
  if (state.inQueueFromCarryover) {
    return {
      action:           'wait',
      reason:           'awaiting_overnight_purge',
      secondsUntilFire: Infinity, // SAN's purge time isn't predictable
      logLine:          `[Pos] ${veh} — ⏸ carryover from yesterday (waiting for SAN to drop, queue: ${waitingCount})`,
      metrics:          baseMetrics,
    };
  }
  if (state.hasBeenSeen) {
    return {
      action:  'skip_already_seen',
      reason:  'driver_already_in_queue_today',
      logLine: `[Pos] ${veh} — already in queue today, skipping`,
      metrics: baseMetrics,
    };
  }

  // ─── Already past max — abort, the train has left the station ────────────
  // If the queue is ALREADY beyond maxAcceptable at fire-decision time, there
  // is no possible bot completion time where the driver lands at-or-better
  // than max. Firing anyway just wastes a bot slot and produces a record like
  // "target 350, actual 481" which is meaningless data. Mark the row as
  // missed_impossible so the admin UI shows what happened.
  if (waitingCount > maxAcceptable) {
    return {
      action:  'missed_impossible',
      reason:  'queue_already_past_max',
      logLine: `[Pos] ${veh} — ✗ queue ${waitingCount} > max ${maxAcceptable} (target ${effectivePosition}) — too late, skipping`,
      metrics: { ...baseMetrics, queueSize: waitingCount },
    };
  }

  // ─── Dispatch-purge guard ────────────────────────────────────────────────
  // If the queue is actively shrinking (a dispatch batch just opened — common
  // at the 5 AM operating-hour boundary), pause for a poll cycle. Otherwise
  // the projection will fire bots that land 50-80 positions BELOW target
  // because between the fire decision and bot completion, 50+ drivers move
  // out of waiting → dispatched.
  if (queueShrinkageDetected) {
    return {
      action:  'wait',
      reason:  'queue_shrinking',
      secondsUntilFire: 30, // re-poll soon
      logLine: `[Pos] ${veh} — ⏸ queue shrinking (target ${effectivePosition}, queue ${waitingCount}) — waiting for purge to settle`,
      metrics: { ...baseMetrics, queueSize: waitingCount },
    };
  }

  // ─── Projection and fire decision ─────────────────────────────────────────
  // Fire as soon as projection reaches target — bounded above by maxAcceptable.
  // Bias correction is layered in to compensate for systematic landing errors
  // observed in recent history.
  const projectedLanding = waitingCount + estimatedDrift + biasCorrection;

  // If the projection says we'd land ABOVE maxAcceptable, the train has left
  // the station: every second we wait, the queue grows further past max. The
  // 2026-05-27 #695 incident (target 105, max 125, fired anyway, landed at
  // 167) was exactly this — projection was 167 but the code only checked
  // projection ≥ target. Record the miss instead of producing a +62 landing.
  // The earlier `waitingCount > maxAcceptable` rail still catches the case
  // where the queue is already past max; this one covers "still below max
  // right now, but the projected landing is past max."
  if (projectedLanding > maxAcceptable) {
    return {
      action:  'missed_impossible',
      reason:  'projection_exceeds_max',
      logLine: `[Pos] ${veh} — ✗ projection ${projectedLanding.toFixed(1)} > max ${maxAcceptable} ` +
               `(queue ${waitingCount} + drift ${estimatedDrift}` +
               `${biasCorrection !== 0 ? ` + bias ${biasCorrection.toFixed(1)}` : ''}, ` +
               `target ${effectivePosition}) — too late, skipping`,
      metrics: {
        ...baseMetrics,
        queueSize:        waitingCount,
        growthRate:       effectiveGrowthRate,
        estimatedDrift,
        predictedLanding: Math.round(projectedLanding),
      },
    };
  }

  const shouldFire = projectedLanding >= effectivePosition;

  // secondsUntilFire drives adaptive polling — how soon do we expect to fire?
  // Negative projection (already past target) → 0; no growth → Infinity.
  const positionsUntilFire = effectivePosition - projectedLanding;
  const secondsUntilFire   = effectiveGrowthRate > 0 && positionsUntilFire > 0
    ? positionsUntilFire / effectiveGrowthRate
    : (positionsUntilFire <= 0 ? 0 : Infinity);

  if (shouldFire) {
    return {
      action:  'fire',
      reason:  'projection_reached_target',
      effectivePosition,
      maxAcceptable,
      secondsUntilFire,
      logLine: `[Pos] ${veh} — ✓ queue ${waitingCount} + drift ${estimatedDrift}` +
               `${biasCorrection !== 0 ? ` + bias ${biasCorrection.toFixed(1)}` : ''} ` +
               `= ${projectedLanding.toFixed(1)} ≥ target ${effectivePosition} ` +
               `(max ${maxAcceptable}, rate ${effectiveGrowthRate.toFixed(2)}/s, ` +
               `horizon ${horizonSeconds.toFixed(0)}s, botP95 ${(botExecMs/1000).toFixed(1)}s, ` +
               `samples ${botSamplesCount}) — firing bot`,
      fireOpts: {
        growthRate:            effectiveGrowthRate,
        estimatedDrift,
        predictedLanding:      Math.round(projectedLanding),
        maxAcceptablePosition: maxAcceptable,
      },
    };
  }

  // ─── Wait ─────────────────────────────────────────────────────────────────
  return {
    action:  'wait',
    reason:  'projected_below_target',
    secondsUntilFire,
    logLine: `[Pos] ${veh} — waiting (queue: ${waitingCount}, drift: ${estimatedDrift}, ` +
             `bias: ${biasCorrection.toFixed(1)}, projected: ${projectedLanding.toFixed(1)}, ` +
             `target: ${effectivePosition}, max: ${maxAcceptable}, ` +
             `secsToFire: ${Number.isFinite(secondsUntilFire) ? secondsUntilFire.toFixed(0) : '∞'})`,
    metrics: {
      ...baseMetrics,
      queueSize:        waitingCount,
      growthRate:       effectiveGrowthRate,
      estimatedDrift,
      predictedLanding: Math.round(projectedLanding),
    },
  };
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
      s.lastPosDecision    = null; // new day → next decision will write a fresh row
      s.pendingTrackingId  = null;

      // Carryover: V Holding clears overnight (SAN dispatches the leftovers and
      // empties the list before ~3 AM PT), so a driver still in queue at midnight
      // will be dropped before morning. Tag them so the state machine doesn't
      // immediately flip hasBeenSeen back to true on the next poll — that path
      // makes the position scheduler skip the driver for the day even though
      // SAN is about to clear them. The flag is cleared automatically when the
      // driver leaves V Holding (see poll loop below).
      s.inQueueFromCarryover = !!s.hasBeenSeen;

      s.hasBeenSeen        = false;
      s.state              = s.inQueueFromCarryover ? 'in_queue' : 'watching';
      s.terminalSeen       = false;
      s.terminalCheckCount = 0;
      s.terminalName       = null;
      s.terminalPosition   = null;
      s.atTerminalSince    = null;
      s.manuallyRemovedAt  = null;  // new day → driver can be auto-managed again
    }
    console.log('[Monitor] Daily reset — counters and visibility state cleared');
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
  prevObservationAt = lastObservationAt;
  lastObservationAt = Date.now(); // record when this snapshot was taken
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
  // Rate is in drivers/second so horizon math stays correct even if poll intervals drift.
  //
  // Three rate signals, take the max:
  //   lastPollRate      — drivers added since the previous poll ÷ elapsed seconds
  //   shortWindowRate   — drivers added over the last SHORT_WINDOW_POLLS polls ÷ elapsed
  //                       more stable than a single delta, reacts faster than EMA
  //   EMERGENCY_SURGE_RATE — configurable floor (default 0.5/s) that protects the
  //                       cold-start case (first poll of the morning, no prior data)
  //
  // smoothedGrowthRate (EMA α=0.7) is kept as an additional signal alongside the others.
  // prevWaitingCount is null on first tick → skip to avoid a false 0→N spike.

  // Maintain rolling observation buffer (oldest first)
  recentObservations.push({ count: waitingCount, observedAt: lastObservationAt });
  if (recentObservations.length > SHORT_WINDOW_POLLS + 1) recentObservations.shift();

  // Hoisted so the snapshot recording below has access to the raw signals.
  let lastPollRate        = null;
  let shortWindowRate     = null;
  let effectiveGrowthRate = EMERGENCY_SURGE_RATE; // floor — never starts at zero
  let queueShrinkageDetected = false;
  if (prevWaitingCount !== null && prevObservationAt !== null) {
    const secondsElapsed = Math.max(1, (lastObservationAt - prevObservationAt) / 1000);
    const rawDelta       = waitingCount - prevWaitingCount; // signed
    const rawGrowth      = Math.max(0, rawDelta);
    lastPollRate         = rawGrowth / secondsElapsed;

    // Detect queue purges: a big drop within a single poll window indicates
    // SAN just promoted a batch from waiting → dispatched (common at 5 AM
    // dispatch open). The 10-driver threshold is intentionally well above
    // normal noise so we don't pause on individual departures.
    if (rawDelta <= -10) queueShrinkageDetected = true;

    smoothedGrowthRate = smoothedGrowthRate * 0.3 + lastPollRate * 0.7; // EMA α=0.7

    // Short-window rate: slope over the last SHORT_WINDOW_POLLS observations
    shortWindowRate = 0;
    if (recentObservations.length >= SHORT_WINDOW_POLLS) {
      const oldest = recentObservations[0];
      const windowSecs = Math.max(1, (lastObservationAt - oldest.observedAt) / 1000);
      shortWindowRate = Math.max(0, (waitingCount - oldest.count) / windowSecs);
    }

    effectiveGrowthRate = Math.max(
      lastPollRate,
      shortWindowRate,
      smoothedGrowthRate,
      EMERGENCY_SURGE_RATE,
    );
  }
  prevWaitingCount = waitingCount;

  // ─── Snapshot for burst-pattern analysis ─────────────────────────────────
  // Fire-and-forget. One row per poll captures the full queue + prediction
  // state so we can later analyse position-dependent growth bursts
  // (e.g. "queue surges around position 115 on Saturdays at 5:30 AM").
  // The scheduler doesn't use this data at runtime — it's pure data collection.
  QueueSnapshot.record({
    waitingCount,
    dispatchedCount:     dispatched.size,
    notAuthorizedCount:  notAuthorized.size,
    lastPollRate,
    shortWindowRate,
    smoothedGrowthRate,
    effectiveGrowthRate,
    botP95Ms:            botExecutionEstimateMs(),
    botLatencySamples:   botLatencySamples.length,
    biasCorrection,
    pollIntervalMs:      currentPollDelayMs,
  }).catch((err) => console.error('[QueueSnapshot] insert failed:', err.message));

  // ─── Periodic bias correction refresh ─────────────────────────────────────
  // Recomputes median(actual - target) from recent position_tracking records.
  // Only runs every BIAS_REFRESH_EVERY ticks and only when we have enough data.
  //
  // The median is computed with outliers (|err|>30) already filtered out — see
  // PositionTracking.medianRecentError. The clamp below is the second line of
  // defense: if some new contamination path slips past the filter, the bias
  // still can't pull the predictor more than BIAS_CAP_POSITIONS off its raw
  // drift estimate. The clamp is logged when it actually trims so we can spot
  // regressions in the data quality.
  biasPollCount++;
  if (biasPollCount % BIAS_REFRESH_EVERY === 0) {
    PositionTracking.medianRecentError(30).then((med) => {
      if (med === null) return;
      const clamped = Math.max(-BIAS_CAP_POSITIONS, Math.min(BIAS_CAP_POSITIONS, med));
      const wasClamped = clamped !== med;
      biasCorrection = clamped;
      const sign = biasCorrection > 0 ? '+' : '';
      const note = wasClamped ? ` (clamped from ${med > 0 ? '+' : ''}${med.toFixed(1)})` : '';
      console.log(`[PosTracking] Bias correction updated: ${sign}${biasCorrection.toFixed(1)} positions${note}`);
    }).catch(() => {}); // non-blocking — ignore DB errors here
  }

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

    // Carryover handling: drivers still in V Holding at midnight will be cleared
    // by SAN before morning. While inQueueFromCarryover is true we observe them
    // but DON'T flip hasBeenSeen — the position scheduler treats them as armed
    // for today so it can fire properly once SAN drops them. The flag is
    // cleared automatically the first poll the driver is no longer in V Holding.
    const isCarryover = state.inQueueFromCarryover;
    const markSeen    = () => { if (!isCarryover && !state.hasBeenSeen) state.hasBeenSeen = true; };

    if (inNotAuthorized) {
      // Driver is in the red "not authorized" zone — visible but blocked by SAN.
      // Do NOT set hasBeenSeen (they haven't earned a queue spot) and do NOT requeue.
      next = 'not_authorized';
    } else if (inDispatched) {
      markSeen();
      state.lastSeenAt = new Date();
      if (prev !== 'dispatched') state.lastDispatchAt = new Date();
      next = isCarryover ? 'in_queue' : 'dispatched';
    } else if (inWaiting) {
      // Record actual landing position whenever we see a fired driver in the
      // queue with a pending tracking row — independent of hasBeenSeen, which
      // _runBot already flips to true on success. Gating on hasBeenSeen used to
      // mean successful bot fires NEVER landed their actual_position (the bot
      // set hasBeenSeen=true before the next poll could observe the entry),
      // so every successful fire showed up as "pending" in the admin UI.
      // pendingTrackingId is the single-shot guard: cleared before awaiting
      // to prevent a second poll racing this update.
      if (state.pendingTrackingId && livePosition) {
        const trackingId = state.pendingTrackingId;
        state.pendingTrackingId = null;
        PositionTracking.updateActualPosition(trackingId, livePosition)
          .then(() => console.log(`[PosTracking] #${state.vehicleNumber} landed at ${livePosition} (target was recorded)`))
          .catch((err) => console.error('[PosTracking] Failed to update actual position:', err.message));
      }
      markSeen();
      state.lastSeenAt = new Date();
      // If transitioning from at_terminal → in_queue, SAN auto-returned the driver
      // to V Holding before the terminal poll could detect they'd left. Collect for
      // requeue below (after the stateChanged broadcast fires) so we don't double-emit.
      if (prev === 'at_terminal') {
        returnedFromTerminal.push({ driverId, state });
      }
      next = 'in_queue';
    } else if (isCarryover) {
      // Driver was carryover and is no longer in V Holding — SAN's overnight
      // purge has cleared them. Drop the flag and reset to 'watching' so the
      // position scheduler can fire at the right time today. NO at_terminal
      // transition (we never claimed they were ours today, no requeue owed).
      state.inQueueFromCarryover = false;
      console.log(`[Monitor] #${state.vehicleNumber} — SAN cleared overnight carryover, armed for fresh schedule`);
      next = 'watching';
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
    } else if (
      // Same defer-to-position-scheduler logic as the cleared-terminal block.
      (state.scheduledPosition || state.dayPositions)
      && !state.positionFiredToday
      && isWithinPositionHours()
    ) {
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — deferring requeue ` +
        `(position scheduler hasn't decided yet today)`,
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
          } else if (
            // Defer to position scheduler: if this driver has a position target
            // and the scheduler hasn't reached a decision yet today, let it
            // decide first. Otherwise the monitor would land them at whatever
            // low position exists at 5 AM, robbing the scheduler of the chance
            // to fire at the actual target window later in the morning.
            //
            // The scheduler always marks positionFiredToday=true on 'fire', so
            // this defer ALWAYS releases — either when the scheduler fires for
            // this driver, or naturally when position hours end
            // (isWithinPositionHours becomes false).
            (state.scheduledPosition || state.dayPositions)
            && !state.positionFiredToday
            && isWithinPositionHours()
          ) {
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — deferring requeue ` +
              `(position scheduler hasn't decided yet today)`,
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
  // Dynamic lead using real poll age + bot execution time (both in seconds).
  // horizonSeconds = how far into the future we need to predict queue size:
  //   pollAgeSeconds   — data already stale by this many seconds when we read it
  //   botExecutionEstimateMs() — rolling P95 of recent bot runs (cold-start: POS_BOT_EXEC_MS)
  //   SAFETY_BUFFER_SECS — extra cushion against under-prediction
  // estimatedDrift = rate(drivers/sec) × horizonSeconds → positions added during that window.
  // biasCorrection  — median of recent (actual - target) landing errors from position_tracking.
  //   If positive (we keep landing too far back), the prediction is bumped up so the bot fires earlier.
  // POS_DRIFT_FLOOR (5) provides a small cushion on near-zero-growth mornings without fabricating
  //   growth that isn't there. Burst-aware effectiveBotExecMs handles the concurrency-contention case
  //   (a bot waiting behind N others in the JobQueue has a longer effective horizon).
  if (isWithinPositionHours()) {
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const DAY_KEY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const todayDayKey = DAY_KEY_MAP[todayDayStr];

  const pollAgeSeconds = lastObservationAt ? (Date.now() - lastObservationAt) / 1000 : POLL_INTERVAL_MS / 1000;
  const botExecMs      = botExecutionEstimateMs();

  // Burst-aware effective bot latency: when multiple bots are already running
  // or pending in the JobQueue, this bot will wait behind them before its own
  // ~botExecMs of work starts. Inflate the per-driver projection accordingly.
  // Formula matches actual queueing: ceil((alreadyInFlight + 1) / concurrency)
  // batches of botExecMs each, e.g. 5 bots already in flight, concurrency 3
  // → this bot is in the 2nd batch → effective wait = 2 × botExecMs.
  const inflightBots         = jobQueue.activeCount + jobQueue.pendingCount;
  const burstBatchPosition   = Math.ceil((inflightBots + 1) / Math.max(1, jobQueue.concurrency));
  const effectiveBotExecMs   = botExecMs * burstBatchPosition;
  const horizonSeconds       = pollAgeSeconds + (effectiveBotExecMs / 1000) + SAFETY_BUFFER_SECS;
  const estimatedDrift       = Math.max(POS_DRIFT_FLOOR, Math.ceil(effectiveGrowthRate * horizonSeconds));

  // Context shared by every per-driver decision. Pure data — no module state.
  const decisionCtx = {
    waitingCount,
    effectiveGrowthRate,
    estimatedDrift,
    biasCorrection,
    horizonSeconds,
    botExecMs,
    todayDayKey,
    botSamplesCount:         botLatencySamples.length,
    queueShrinkageDetected,
  };

  // Track the soonest fire across all armed drivers — drives adaptive polling.
  let minSecondsUntilFire = Infinity;

  for (const [driverId, state] of watches) {
    const decision = evaluatePositionScheduler(state, decisionCtx);

    if (Number.isFinite(decision.secondsUntilFire) && decision.secondsUntilFire < minSecondsUntilFire) {
      minSecondsUntilFire = decision.secondsUntilFire;
    }

    // Apply side effects per decision action
    switch (decision.action) {
      case 'skip_no_target':
        // Driver has no position target today (e.g. day_positions[todayDayKey] is null).
        // Mark positionFiredToday=true so the monitor's defer-to-position-scheduler
        // condition releases. Otherwise the monitor would defer forever on this
        // driver's terminal-cleared events, never requeueing them.
        state.positionFiredToday = true;
        break;

      case 'skip_already_fired':
        console.log(decision.logLine);
        break;

      case 'skip_bot_inflight':
      case 'wait':
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        break;

      case 'skip_already_seen':
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        // Driver is already in queue today — position scheduler's job is done.
        // Mark positionFiredToday=true so the monitor's defer condition releases
        // and it can requeue normally after dispatches throughout the day.
        state.positionFiredToday = true;
        break;

      case 'fire':
        console.log(decision.logLine);
        state.positionFiredToday = true; // mark before enqueuing — prevents double-trigger
        triggerPositionSchedule(driverId, state, decision.effectivePosition, decision.fireOpts)
          .catch(console.error);
        break;

      case 'missed_impossible':
        // Queue is already past max — firing now would land far above max.
        // Record the row for visibility and mark fired so the monitor's
        // defer-to-position-scheduler condition releases (otherwise we'd be
        // stuck waiting forever on this driver).
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        state.positionFiredToday = true;
        break;

      default:
        console.warn(`[Pos] Unknown decision action: ${decision.action}`);
    }
  }

  // Set the adaptive interval for the next scheduled poll. When no drivers are
  // armed (minSecondsUntilFire stays Infinity) this returns POLL_INTERVAL_MS.
  const newDelayMs = expectedNextPollMs(minSecondsUntilFire);
  if (newDelayMs !== currentPollDelayMs) {
    console.log(
      `[Monitor] Poll cadence ${currentPollDelayMs/1000}s → ${newDelayMs/1000}s ` +
      `(nearest fire in ${Number.isFinite(minSecondsUntilFire) ? minSecondsUntilFire.toFixed(0) + 's' : '∞'})`,
    );
    currentPollDelayMs = newDelayMs;
  }
  } else if (currentPollDelayMs !== POLL_INTERVAL_MS) {
    // Outside position hours (e.g. midnight–2 AM PT) → relax cadence.
    console.log(`[Monitor] Poll cadence ${currentPollDelayMs/1000}s → ${POLL_INTERVAL_MS/1000}s (outside position hours)`);
    currentPollDelayMs = POLL_INTERVAL_MS;
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
    scheduledPosition:       driver.scheduled_position ?? null,
    dayPositions:            driver.day_positions ?? null,
    maxAcceptablePosition:   driver.max_acceptable_position ?? null, // null → default to target + 20
    manuallyRemovedAt:       driver.manually_removed_at ?? null,
    positionFiredToday,
    inQueueFromCarryover: false, // set at midnight reset for drivers still in V Holding
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
 * Called by driverController.removeFromQueue after a manual-remove bot succeeds.
 * Resets the driver's in-memory state so:
 *   • monitor doesn't try to auto-requeue them (hasBeenSeen=false → at_terminal
 *     transition never fires)
 *   • position scheduler doesn't fire for them again today (positionFiredToday=true)
 *   • driver can still manually trigger via "Get Back in Queue" — that path
 *     bypasses both checks
 *
 * If the driver isn't currently being watched (rare — possible if they were
 * deactivated mid-removal), this is a no-op.
 */
function markManuallyRemoved(driverId) {
  const state = watches.get(driverId);
  if (!state) {
    console.warn(`[Monitor] markManuallyRemoved: driver ${driverId} not in watches`);
    return false;
  }

  state.hasBeenSeen        = false;
  state.state              = 'watching';
  state.positionFiredToday = true;
  state.terminalSeen       = false;
  state.terminalCheckCount = 0;
  state.terminalName       = null;
  state.terminalPosition   = null;
  state.atTerminalSince    = null;
  state.manuallyRemovedAt  = new Date();

  console.log(`[Monitor] #${state.vehicleNumber} marked manually-removed — auto-requeue suppressed for today`);
  broadcast('driver_state', { driverId, state: snap(state) });
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
        existing.scheduledPosition     = d.scheduled_position ?? null;
        existing.dayPositions          = d.day_positions ?? null;
        existing.maxAcceptablePosition = d.max_acceptable_position ?? null;
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
    pollIntervalMs:   currentPollDelayMs, // live adaptive interval (idle ≤ this ≤ near-fire)
    pollIntervalIdleMs: POLL_INTERVAL_MS, // configured idle ceiling, for UI display
    queueUrl:         QUEUE_URL,
    watches:          [...watches.values()].map(snap),
    recentEvents:     recentRequeuEvents.slice(),
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

  if (pollTimer)    { clearTimeout(pollTimer);    pollTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  // Self-rescheduling chain so the adaptive interval (currentPollDelayMs) can
  // change between ticks. .finally() guarantees we wait for the in-flight poll
  // to finish before scheduling the next one — no overlap, no piling up.
  const schedule = () => {
    pollTimer = setTimeout(() => {
      poll()
        .catch(console.error)
        .finally(() => { if (pollTimer !== null) schedule(); });
    }, currentPollDelayMs);
  };
  schedule();

  refreshTimer = setInterval(() => refreshAutoWatches().catch(console.error), AUTO_REFRESH_MS);

  poll().catch(console.error); // immediate first tick — doesn't block the chain

  console.log(
    `[Monitor] Started — poll cadence ${POLL_INTERVAL_MS / 1000}s idle / ` +
    `${POLL_NEAR_FIRE_MS / 1000}s near fire / ${POLL_AT_FIRE_MS / 1000}s at fire, ` +
    `auto-refresh every ${AUTO_REFRESH_MS / 1000}s, ` +
    `bot concurrency: ${BOT_CONCURRENCY}, ` +
    `watching ${watches.size} driver(s)`,
  );
}

function stopMonitor() {
  if (pollTimer)    { clearTimeout(pollTimer);     pollTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  watches.clear();
  autoDriverIds.clear();
  manualWatchIds.clear();
  prevWaitingCount   = null;
  smoothedGrowthRate = 0;
  lastObservationAt  = null;
  prevObservationAt  = null;
  biasCorrection     = 0;
  biasPollCount      = 0;
  recentObservations.length = 0;
  currentPollDelayMs = POLL_INTERVAL_MS;
}

/** Seconds until next scheduled poll (uses the current adaptive interval). */
function nextPollIn() { return Math.round(currentPollDelayMs / 1000); }

module.exports = {
  startMonitor,
  stopMonitor,
  addWatch,
  removeWatch,
  manualRun,
  markManuallyRemoved,
  watchAllActive,
  refreshAutoWatches,
  getState,
  getStats,
  subscribe,
  nextPollIn,
  // Exposed for unit tests
  _parseQueue:                parseQueue,
  _parseTerminalPage:         parseTerminalPage,
  _norm:                      norm,
  _isWithinOperatingHours:    isWithinOperatingHours,
  _evaluatePositionScheduler: evaluatePositionScheduler,
  _expectedNextPollMs:        expectedNextPollMs,
  _botExecutionEstimateMs:    botExecutionEstimateMs,
  _recordBotLatency:          recordBotLatency,
};
