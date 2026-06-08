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
const proxyHealth         = require('./proxyHealthService');
const credentialLockout   = require('./credentialLockoutService');

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
// and when SAN assigns the queue slot. The actual estimate is the rolling median
// of the last MAX_LATENCY_SAMPLES bot runs (see botExecutionEstimateMs below) —
// this constant is only the cold-start default until we collect enough samples.
//
// 2026-06-07: lowered from 15000 → 7000 after #4377 over-shot target by 36
// positions on a cold-morning fire (botEst fallback × BURST_DRIFT_RATE_CAP = 45
// drift, actual queue grew by 4). Every real bot run observed across June so
// far clusters around 5-9 s; 15 s was a worst-case-with-OIDC-handshake value
// that hasn't matched reality since the session warmer rolled out. 7 s sits
// just above the observed median so we err slightly conservative without
// inflating cold-start drift to 3× reality.
const POS_BOT_EXEC_MS  = parseInt(process.env.MONITOR_POS_BOT_EXEC_MS  ?? '7000', 10);
// Minimum assumed queue growth rate (drivers/second) used as a floor before historical
// data exists and during calm periods. Protects against cold-start on a busy morning.
// Tune down if drivers land too early; tune up if they still land too late.
const EMERGENCY_SURGE_RATE = parseFloat(process.env.MONITOR_EMERGENCY_SURGE_RATE ?? '0.5');
// Extra seconds added to the forecast horizon as a safety cushion.
const SAFETY_BUFFER_SECS   = parseInt(process.env.MONITOR_SAFETY_BUFFER_MS ?? '10000', 10) / 1000;
// Burst window: SAN's morning rush can arrive anywhere between 4:00 and 5:30 AM PT
// and the exact minute shifts daily. We lock the poll to POLL_BURST_MS (1 s) for
// the full 4:00–5:30 AM window so no burst timing catches us at the slow cadence.
//
// Why 1 s instead of 5 s:
//   The queue can jump 50+ positions in a single 5 s tick (observed Jun 04–06).
//   A driver whose target window is only 40 positions wide (e.g. target 140,
//   max 180) can be completely skipped in that one tick. At 1 s, the same burst
//   is spread across 5 ticks — the window is visible for ~8–10 ticks instead of
//   1–2, giving the bot a chance to fire before the queue overshoots.
//
// Configurable via env so the window can be shifted if SAN changes hours.
const BURST_WINDOW_END_MIN   = parseInt(process.env.MONITOR_BURST_END_MIN   ?? '30', 10); // minutes past 5 AM
const POLL_BURST_MS          = parseInt(process.env.MONITOR_BURST_POLL_MS   ?? '1000', 10);
// During burst the measured growth rate can spike to 10–15/s for a single tick
// (e.g. 75 drivers join in 5 s). If we use that raw rate for drift estimation,
// drift = 15 × 15 s = 225 positions — instantly marking every driver with
// max < queue+225 as missed_impossible on the very first burst tick.
// Cap the growth rate used ONLY for drift math during the burst window.
// The uncapped rate still drives the fire-timing decision (secsToFire).
// 3.0/s ≈ the observed sustained plateau rate; tune via env if needed.
const BURST_DRIFT_RATE_CAP   = parseFloat(process.env.MONITOR_BURST_DRIFT_RATE_CAP ?? '3.0');
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

// Returns true during the extended burst window: 4:00 AM–5:30 AM PT (default).
// The SAN rush can arrive at any point in this 90-minute window, so we hold
// the poll at POLL_BURST_MS (1 s) for the entire span rather than trying to
// predict the exact minute. BURST_WINDOW_END_MIN controls how many minutes
// past 5 AM the window runs (default 30 → 5:30 AM).
function isWithinBurstWindow() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value,   10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  // Full hour 4 (4:00–4:59) plus first BURST_WINDOW_END_MIN minutes of hour 5.
  return h === 4 || (h === 5 && m < BURST_WINDOW_END_MIN);
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

// Hard cap on consecutive "already in queue" bot results before we stop
// auto-requeuing a driver for the rest of the day. Protects against the
// case where the bot keeps confirming the driver IS in queue but our V Holding
// parse can't see them — guarantees we don't burn 200+ SAN logins like #142 on
// 2026-06-07. Any *real* add (success && !alreadyQueued) resets the counter.
const MAX_CONSECUTIVE_ALREADY_QUEUED = parseInt(process.env.MONITOR_MAX_CONSECUTIVE_ALREADY_QUEUED ?? '3', 10);

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Proxy dispatcher for polling fetches ─────────────────────────────────────
// Built once at module load (constructing a ProxyAgent is expensive — has a
// connection pool, TLS context, etc.) but consulted via shouldUseProxy() per
// fetch so the circuit breaker can transparently flip everything to direct
// when the proxy goes bad. Uses a single sticky session — polling wants a
// consistent IP, not rotation.
function buildPollDispatcher() {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined;

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

  console.log('[Monitor] Proxy configured for polling →', new URL(proxyUrl).host);
  return new ProxyAgent(proxyUrl);
}

const pollDispatcher = buildPollDispatcher();

/**
 * Returns the dispatcher undici should use for this call: the cached
 * ProxyAgent when the circuit breaker says proxy is OK, undefined when it
 * isn't (kill switch, unconfigured, or breaker open). Called per-fetch so
 * the breaker can transparently flip mid-session.
 */
function currentPollDispatcher() {
  return proxyHealth.shouldUseProxy() ? pollDispatcher : undefined;
}

/**
 * Pattern-match an error to decide whether it's plausibly the PROXY's fault
 * (and so should count against the circuit breaker) vs. something downstream
 * (SAN returning 503, vehicle search returning "not found", etc., which says
 * nothing about proxy health).
 *
 * False positives just trip the breaker slightly more eagerly than ideal —
 * the consequence is we fall back to direct, which is exactly the safe move.
 */
function looksLikeProxyFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('fetch failed')
      || msg.includes('econnrefused')
      || msg.includes('econnreset')
      || msg.includes('etimedout')
      || msg.includes('enotfound')
      || msg.includes('proxy_connection_failed')
      || msg.includes('tunneling socket')
      || msg.includes('http 407'); // proxy auth required
}

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

/**
 * Last calendar day (PT, YYYY-MM-DD) on which we re-armed the position
 * scheduler at the start of position hours. Null until the first 3 AM
 * transition observed since boot. Lets us run the auto-arm exactly once per
 * day, regardless of how many polls fire during the window.
 */
let positionWindowArmedForDate = null;

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

// ─── Bot latency tracking (median + freshness window) ────────────────────────
// Each sample is { ms, recordedAt } — recordedAt lets us discard data older
// than LATENCY_FRESHNESS_MS so a one-time architectural change (e.g. the 5/29
// warmer rollout) doesn't keep dragging the prediction toward stale numbers.
//
// We use the MEDIAN, not P95: with the warmer running, real bot times cluster
// tightly around 7-8 s. P95 was useful when the distribution had a long tail
// of 25 s cold logins; that tail is gone. P95 over current samples drags the
// horizon up by 50%+, which causes the over-predicted drift we saw on 5/29.
//
// In-memory ring buffer. Push is O(1); median is O(n log n) for n=30 (~0.01 ms).
// Persisted to disk so a restart doesn't reset us to cold-start fallback on a
// busy morning. Loader is backwards-compatible with the prior plain-number
// format.
const MAX_LATENCY_SAMPLES  = 30;
const MIN_SAMPLES_FOR_EST  = 5;
// Samples older than this are filtered out before the median is taken.
// 12 h is short enough to discard pre-deploy data after a single morning,
// long enough that an idle midday doesn't leave us with too few samples.
const LATENCY_FRESHNESS_MS = parseInt(
  process.env.MONITOR_BOT_LATENCY_FRESHNESS_MS ?? String(12 * 60 * 60 * 1000), 10,
);
const botLatencySamples    = []; // [{ ms, recordedAt }]; newest pushed to end

// ─── Persistence — survives restarts so cold-start doesn't fall back to the
// POS_BOT_EXEC_MS default on a busy morning ──────────────────────────────────
const LATENCY_PERSIST_PATH = process.env.BOT_LATENCY_PERSIST_PATH
  ?? path.join(process.cwd(), 'data', 'bot-latency-samples.json');
const LATENCY_PERSIST_THROTTLE_MS = 5000;
let latencyPersistTimer = null;

function loadBotLatencyFromDisk() {
  try {
    if (!fs.existsSync(LATENCY_PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LATENCY_PERSIST_PATH, 'utf8'));
    if (!Array.isArray(raw)) return;
    // Backwards compat: prior versions stored plain numbers. Treat those as
    // ancient samples (recordedAt=0) so the freshness filter discards them
    // automatically — old pre-warmer cold-login data shouldn't influence
    // post-warmer predictions.
    for (const entry of raw) {
      if (botLatencySamples.length >= MAX_LATENCY_SAMPLES) break;
      const sample = normaliseLatencySample(entry);
      if (sample) botLatencySamples.push(sample);
    }
    if (botLatencySamples.length) {
      console.log(`[Monitor] Restored ${botLatencySamples.length} bot-latency samples from disk`);
    }
  } catch (err) {
    console.warn(`[Monitor] Could not load latency samples (${err.message}) — starting fresh`);
  }
}

/**
 * Normalise a disk entry into the current { ms, recordedAt } shape.
 * Returns null for malformed input. Exported via `_normaliseLatencySample`
 * so tests can verify the back-compat behaviour without touching disk.
 */
function normaliseLatencySample(entry) {
  if (Number.isFinite(entry) && entry > 0) {
    return { ms: entry, recordedAt: 0 }; // legacy plain-number format
  }
  if (entry && Number.isFinite(entry.ms) && entry.ms > 0) {
    return { ms: entry.ms, recordedAt: Number.isFinite(entry.recordedAt) ? entry.recordedAt : 0 };
  }
  return null;
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

function recordBotLatency(durationMs, { now = Date.now() } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  botLatencySamples.push({ ms: durationMs, recordedAt: now });
  if (botLatencySamples.length > MAX_LATENCY_SAMPLES) botLatencySamples.shift();
  schedulePersistBotLatency();
}

// Eagerly load on module import so the first poll already has data.
loadBotLatencyFromDisk();

/**
 * Returns the bot execution estimate (ms) used by the drift forecast.
 *   • Fewer than MIN_SAMPLES_FOR_EST FRESH samples → POS_BOT_EXEC_MS fallback
 *   • Otherwise → median of FRESH samples (newer than LATENCY_FRESHNESS_MS old)
 *
 * Median rather than P95 because the post-warmer distribution is tight and
 * symmetric — P95 systematically over-estimates by tracking outliers we no
 * longer have. Freshness window discards pre-warmer cold-login samples that
 * would otherwise hold the estimate artificially high for ~30 bot runs.
 *
 * Pure function in spirit; reads the module-scope sample array but no other
 * state. `now` is injectable so tests can exercise the freshness cutoff
 * without touching the system clock.
 */
function botExecutionEstimateMs({ now = Date.now() } = {}) {
  const cutoff = now - LATENCY_FRESHNESS_MS;
  const fresh  = botLatencySamples
    .filter((s) => s.recordedAt >= cutoff)
    .map((s) => s.ms);
  if (fresh.length < MIN_SAMPLES_FOR_EST) return POS_BOT_EXEC_MS;
  return computeMedian(fresh);
}

/**
 * Median of a non-empty array of numbers. Sorts a copy so caller's array is
 * not mutated. Exported via `_computeMedian` for unit tests.
 */
function computeMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// EventEmitter — decouples SSE clients from service logic
const emitter = new EventEmitter();
emitter.setMaxListeners(500); // support many concurrent admin browser tabs

// ─── HTML parser (zero dependencies) ─────────────────────────────────────────
/** Normalise a vehicle ID: strip whitespace, uppercase. */
// Strip leading zeros so SAN's padded canonical form ("0142") and our possibly
// unpadded DB value ("142") hash to the same key. Without this the V Holding
// parser and state.vehicleNorm can disagree, leaving a driver permanently
// invisible to polling — observed 2026-06-07 with #142, which triggered a
// 22-minute requeue loop because the bot's WAIT screen showed "Vehicle: 0142"
// while the DB stored "142". (?=\d) keeps a lone "0" intact.
const norm = (id) => String(id ?? '').replace(/\s+/g, '').toUpperCase().replace(/^0+(?=\d)/, '');

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
    earlyJoinPosition:     metrics.earlyJoinPosition ?? null,
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
    earlyJoinDetectedAt: state.earlyJoinDetectedAt, // time of first early-join detection
    earlyJoinAtPosition: state.earlyJoinAtPosition, // queue pos where driver joined early
  };
}

// ─── Re-queue trigger (used by auto-detection & manual run) ──────────────────
async function _runBot(driverId, state, triggerType = 'monitor_requeue') {
  // Lazy-require to break circular dependency (monitorService ← schedulerService).
  const { runBotForDriver } = require('./schedulerService');

  const driver = await Driver.findByIdWithCredentials(driverId);
  if (!driver || !driver.is_active) throw new Error('Driver not found or inactive');

  const result = await runBotForDriver(driver, triggerType);

  // Record execution time for the rolling estimator used by drift prediction.
  // Only genuine *new* adds belong in this pool — fast paths and failure paths
  // are not representative of the latency the position scheduler needs to plan
  // for, and including them collapses the median:
  //   • alreadyQueued      → bot lands on WAIT screen in 1-2 s without adding;
  //                          dominated the pool on 2026-06-07 (#142 alone fed
  //                          200+ fast samples), driving botEst from ~6 s down
  //                          to 1.5 s and causing the burst's +15 to +26 over-
  //                          shoots.
  //   • !success           → timeouts pin near 60 s; credential fast-fails
  //                          pin near 1 s. Neither represents a real add.
  //   • recoveredFromTimeout → bot did attempt the add, but durationMs is the
  //                          timeout cap, not real work time — also unrepresentative.
  // Per-row PositionTracking duration is still recorded unconditionally — it's
  // a bookkeeping field for the Position Accuracy report, not a calibration signal.
  if (Number.isFinite(result?.durationMs)) {
    const representsRealAdd =
      result.success
      && !result.alreadyQueued
      && !result.recoveredFromTimeout;
    if (representsRealAdd) recordBotLatency(result.durationMs);
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
    // A real add proves the driver was NOT in queue — clear any runaway guard.
    state.consecutiveAlreadyQueued = 0;
    state.requeueBlockedReason     = null;
  } else if (result?.success && result?.alreadyQueued && !result?.recoveredFromTimeout) {
    // Bot kept finding the driver already in queue while our poll never sees
    // them — almost certainly a key mismatch (e.g. SAN canonical "0142" vs DB
    // "142"). Bump the consecutive counter; the requeue gate below uses it to
    // stop hammering SAN after MAX_CONSECUTIVE_ALREADY_QUEUED hits.
    state.consecutiveAlreadyQueued = (state.consecutiveAlreadyQueued || 0) + 1;
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
  } else if (state.pendingTrackingId && !result?.success) {
    // Bot returned a non-success result without throwing. This is the path for
    // fast-fail outcomes: credential lockout, "Vehicle not available for
    // registration", "vehicle not found", etc. Without clearing the handle
    // here, the next poll observes the driver in V Holding (possibly from a
    // completely unrelated channel — manual fire, auto-requeue, self-add) and
    // writes that position as the actual. That's the +116 #631 contamination
    // we observed on 2026-05-29.
    //
    // We also mark the row as failed so the Position Accuracy table shows the
    // outcome clearly rather than leaving it in 'pending' forever. The 'fired'
    // decision stays in place for analytics; markFailed just appends the
    // failure context.
    const failedTrackingId = state.pendingTrackingId;
    state.pendingTrackingId = null;
    const reason = result?.error || result?.message || 'unknown bot failure';
    PositionTracking.markFailed(failedTrackingId, reason)
      .catch((err) => console.error('[PosTracking] markFailed (non-success) error:', err.message));
    console.log(`[PosTracking] #${state.vehicleNumber} → bot returned failure (${reason}) — row marked failed, NOT recording actual_position`);
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
    // Re-checked per attempt so the breaker can trip mid-retry and the very
    // next attempt goes direct. The dispatcher is undefined when proxy is
    // disabled / unconfigured / breaker open.
    const dispatcher    = currentPollDispatcher();
    const proxyAttempt  = dispatcher !== undefined;

    try {
      const res = await ufetch(url, {
        headers:    { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal:     AbortSignal.timeout(FETCH_TIMEOUT),
        dispatcher,
      });
      if (!res.ok) {
        // Treat 407 Proxy Auth Required as a proxy failure; everything else
        // (SAN 5xx, etc.) is a SAN-side problem and shouldn't trip the breaker.
        const httpErr = new Error(`HTTP ${res.status}`);
        if (proxyAttempt && res.status === 407) proxyHealth.reportFailure('http 407');
        throw httpErr;
      }
      if (proxyAttempt) proxyHealth.reportSuccess();
      if (attempt > 0) console.log(`[Monitor] Fetch succeeded on attempt ${attempt + 1} (${url})`);
      return res;
    } catch (err) {
      lastErr = err;
      if (proxyAttempt && looksLikeProxyFailure(err)) {
        proxyHealth.reportFailure(err.message || 'fetch failed');
      }
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
      if (attempt < RETRY_COUNT - 1) {
        const via = proxyAttempt ? 'via proxy' : 'direct';
        console.warn(`[Monitor] Fetch attempt ${attempt + 1}/${RETRY_COUNT} (${via}) failed (${url}): ${err.message} — retrying in ${delay / 1000}s`);
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
//   { action: 'skip_locked_out'     , reason, logLine, metrics }       // creds bad
//   { action: 'skip_bot_inflight'   , reason, logLine, metrics }
//   { action: 'skip_already_seen'   , reason, logLine, metrics }
//   { action: 'fire'                , reason, logLine, fireOpts, ... } // sets positionFiredToday
//   { action: 'wait'                , reason, logLine, metrics, secondsUntilFire }
//   { action: 'missed_impossible'   , reason, logLine, metrics }       // queue already past max
//
// `isLockedOut` is injected via ctx so this function stays pure and unit-testable
// without depending on the credentialLockoutService singleton.
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
    isLockedOut             = () => false,
    inBurstWindow           = false,
  } = ctx;

  // Inactive drivers have no business being scheduled. isActive is synced to the
  // in-memory state immediately on deactivation and every AUTO_REFRESH_MS — but
  // during the brief gap before refresh we still want to block the bot from
  // running. Treat the same as skip_no_target so positionFiredToday is set and
  // the defer guard releases (preventing an eternal hold on terminal-cleared events).
  if (state.isActive === false) return { action: 'skip_no_target' };

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
    : effectivePosition + 40; // widened from +20: the corrected drift formula keeps
                               // projections accurate for typical bursts (~1–2/s), but
                               // extreme spikes (4–5/s) can still temporarily push drift
                               // past the old +20 ceiling and block drivers with viable
                               // windows (e.g. Jun 04 #354: proj=138 > max=131, landed
                               // at +7 when fired). Drivers who want tighter control can
                               // set maxAcceptablePosition explicitly in their profile.

  const baseMetrics = { targetPosition: effectivePosition, maxAcceptablePosition: maxAcceptable };
  const veh         = `#${state.vehicleNumber}`;

  // ─── Early skip checks ────────────────────────────────────────────────────
  if (state.positionFiredToday) {
    return {
      action:  'skip_already_fired',
      logLine: `[Pos] ${veh} — already fired today (target: ${effectivePosition}), skipping`,
    };
  }
  // Credentials confirmed bad earlier (warmer or a prior bot run). Skip the
  // fire so we don't burn a slot on a guaranteed failure — and so we don't
  // create a "fired" position_tracking row that the next V Holding observation
  // could contaminate (the +116 #631 path from 2026-05-29). NOT marking
  // positionFiredToday so that if the admin updates the SAN password mid-day
  // and clears the lockout, the scheduler picks them up again automatically.
  if (isLockedOut(state.driverId)) {
    return {
      action:  'skip_locked_out',
      reason:  'credentials_locked_out',
      logLine: `[Pos] ${veh} — credentials locked out, skipping (driver must update SAN password)`,
      metrics: baseMetrics,
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
               `horizon ${horizonSeconds.toFixed(0)}s, botEst ${(botExecMs/1000).toFixed(1)}s, ` +
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
      s.consecutiveAlreadyQueued = 0;
      s.requeueBlockedReason     = null;

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
      s.earlyJoinDetectedAt = null;
      s.earlyJoinAtPosition = null;
    }
    console.log('[Monitor] Daily reset — counters and visibility state cleared');
    broadcast('daily_reset', { date: currentDayPT });
  }

  // ─── Position-window arming (3 AM PT) ─────────────────────────────────────────
  // SAN's V Holding clears overnight, so any manual bot run a driver makes
  // before ~3 AM lands them at a position far below their actual target. The
  // midnight reset only clears requeueCountToday and (for carryover drivers)
  // tags them as such — it does NOT reset the flags set by a SUCCESSFUL
  // manual or auto-fire that happened between 00:00 and the start of the
  // position window. That left drivers like #4007 stuck at #28 from a 12:30 AM
  // manual run, blocked from re-firing at their real target later.
  //
  // Fires once per day at the open of the position window — see armPosition
  // WindowForToday() below for what gets reset and why.
  if (isWithinPositionHours() && positionWindowArmedForDate !== currentDayPT) {
    positionWindowArmedForDate = currentDayPT;
    armPositionWindowForToday(currentDayPT);
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
    // Field name preserved for the existing bot_p95_ms column. The value is
    // now the median of fresh samples, not P95 — see botExecutionEstimateMs.
    // Future migration can rename the column to bot_est_ms when convenient.
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
    } else if (!state.isActive) {
      // Driver was deactivated mid-session. Don't requeue — they're no longer
      // participating. isActive is synced immediately on deactivation and again
      // every AUTO_REFRESH_MS so the window where a stale true value lingers is ≤ 5 min.
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — driver inactive, skipping requeue`,
      );
    } else if (hasTodayPositionTarget(state) === false) {
      // Driver has a per-day position schedule and today is disabled. Returning from
      // terminal on an off-day should not put them back in queue — the day is off.
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — today disabled in position schedule, skipping requeue`,
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
          } else if (!state.isActive) {
            // Driver deactivated — do not re-add them.
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — driver inactive, skipping requeue`,
            );
          } else if (hasTodayPositionTarget(state) === false) {
            // Per-day schedule: driver has explicitly disabled today. Clearing
            // terminal on an off-day should not put them back in queue.
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — today disabled in position schedule, skipping requeue`,
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
          } else if (state.consecutiveAlreadyQueued >= MAX_CONSECUTIVE_ALREADY_QUEUED) {
            // Runaway guard. The bot has reported "already in queue" this many
            // times in a row but our poll never sees the driver — strong signal
            // the V Holding key doesn't match (padding/data issue). Stop the
            // requeue cycle for the day; admin will see the warning and can fix
            // the underlying mismatch. Cleared on any real add or midnight reset.
            if (!state.requeueBlockedReason) {
              state.requeueBlockedReason = 'consecutive_already_queued';
              console.warn(
                `[Monitor] ⚠️  #${state.vehicleNumber} — bot reported "already in queue" ` +
                `${state.consecutiveAlreadyQueued}× in a row but poll never sees the driver. ` +
                `Suspected V Holding key mismatch (e.g. SAN canonical "0${state.vehicleNumber}" vs DB "${state.vehicleNumber}"). ` +
                `Auto-requeue disabled until next real add or midnight reset.`,
              );
            }
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

  // During burst window, drop the SAFETY_BUFFER from the horizon.
  //
  // The SAFETY_BUFFER (10 s) was added to protect against slow-growth mornings
  // where the queue creeps along at 0.5/s — adding 5 extra "buffer" positions
  // keeps us from landing right at target when variability is high.
  //
  // During the burst (rate ≥ 1 driver/s) the buffer has the OPPOSITE effect:
  //   horizon = pollAge(5s) + botExec(4s) + buffer(10s) = 19 s
  //   drift   = 2.23/s × 19s = 42  →  projection hugely over-estimated
  //   result  = driver fires 25-40 positions too early, OR is judged as
  //             "missed_impossible" when it still has a viable window.
  //
  // Without the buffer at burst rate (2.23/s):
  //   horizon = 5 + 4 = 9 s
  //   drift   = 2.23 × 9 = 20  →  accurate: queue grows ~20 between decision and join
  //
  // The ±10 target cannot be achieved while SAFETY_BUFFER inflates burst drift 3×.
  const inBurstWindow  = isWithinBurstWindow();
  const safetyBufferS  = inBurstWindow ? 0 : SAFETY_BUFFER_SECS;
  const horizonSeconds = pollAgeSeconds + (effectiveBotExecMs / 1000) + safetyBufferS;

  // During burst, a single-tick spike (e.g. 75 drivers join in 1–5 s) pushes
  // the measured growth rate to 15–75/s. Raw: drift = 75 × 15 s = 1 125 →
  // every driver instantly gets missed_impossible before any bot can fire.
  //
  // Cap the rate used FOR DRIFT MATH ONLY to BURST_DRIFT_RATE_CAP (3.0/s).
  // The uncapped effectiveGrowthRate still drives secsToFire (fire timing) so
  // the bot still fires at the right moment — we just don't let the drift
  // estimate explode and falsely rule out drivers that still have valid windows.
  //
  // 3.0/s ≈ sustained burst plateau observed across Jun 03–06 data.
  // After a spike tick the smoothed rate returns to 1–2/s within a few ticks,
  // so this cap only bites on the one or two ticks immediately after the jump.
  const driftRate      = inBurstWindow
    ? Math.min(effectiveGrowthRate, BURST_DRIFT_RATE_CAP)
    : effectiveGrowthRate;
  const estimatedDrift = Math.max(POS_DRIFT_FLOOR, Math.ceil(driftRate * horizonSeconds));

  // Context shared by every per-driver decision. Pure data — no module state.
  // isLockedOut is injected so evaluatePositionScheduler stays a pure function
  // (no singleton coupling) — tests can pass their own predicate.
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
    isLockedOut:             credentialLockout.isLockedOut,
    inBurstWindow,
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

      case 'skip_locked_out':
        // Same handling as a 'wait' decision — log + record decision row so the
        // admin can see why the scheduler isn't firing. We deliberately do NOT
        // set positionFiredToday: if the admin updates the SAN password and
        // clears the lockout mid-day, the next poll evaluates this driver
        // normally and may fire at the target later.
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        break;

      case 'skip_bot_inflight':
      case 'wait':
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        break;

      case 'skip_already_seen': {
        // Driver is already visible in V Holding. Check whether they joined
        // significantly early (manual join before the burst window).
        const livePos = state.currentPosition;
        const target  = decision.metrics?.targetPosition ?? null;
        // "Early join" = driver is in queue more than 30 positions ahead of
        // their target. Threshold of 30 lets normal ±20 bias variance pass
        // while catching the real problem: joining at pos 2 when target is 121.
        const isEarlyJoin = (
          target  != null &&
          livePos != null &&
          livePos < (target - 30)
        );

        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, {
          ...decision.metrics,
          earlyJoinPosition: isEarlyJoin ? livePos : null,
        });

        if (isEarlyJoin) {
          // Record first detection timestamp + position (once per early-join episode)
          if (!state.earlyJoinDetectedAt) {
            state.earlyJoinDetectedAt = new Date();
            state.earlyJoinAtPosition = livePos;
          }

          // AUTO-REARM: treat the driver exactly like an overnight carryover.
          // Setting inQueueFromCarryover=true + hasBeenSeen=false tells the
          // existing carryover machinery to:
          //   1. Hold the position scheduler (→ wait, awaiting_overnight_purge)
          //      while the driver is still in V Holding at the wrong position.
          //   2. Arm them for a fresh fire the moment they leave V Holding —
          //      the carryover flag clears and state→watching/hasBeenSeen=false,
          //      so the burst-window scheduler evaluates them normally and fires
          //      the bot at the correct queue depth.
          // Only set if carryover isn't already active from a previous cycle.
          if (!state.inQueueFromCarryover) {
            state.inQueueFromCarryover = true;
            state.hasBeenSeen          = false;
            console.warn(
              `[Pos] ⚠️  #${state.vehicleNumber} early-join auto-rearm ` +
              `(pos ${livePos}, target ${target}). ` +
              `Tagged as carryover — will fire once driver leaves queue.`,
            );
          }
          // positionFiredToday stays false — scheduler remains live
        } else {
          // Driver is in queue at or near their target. Day's work is done.
          state.positionFiredToday = true;
        }
        break;
      }

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

  // Set the adaptive interval for the next scheduled poll.
  // During the burst window (4:00–5:30 AM PT) lock to POLL_BURST_MS (1 s)
  // regardless of secsToFire — the growth rate estimate is unreliable right
  // after a fire (the queue temporarily dips as the newly-added driver appears,
  // making the rate look slower than it really is). The relaxation to 30 s that
  // cost us 10 drivers on Jun 05 happened exactly here.
  // 1 s vs 5 s: at 5 s the queue can jump 50 positions in one tick, skipping a
  // 40-position target window entirely. At 1 s the same jump is 5 ticks of ~10
  // positions, giving multiple chances to fire before the window closes.
  const newDelayMs = isWithinBurstWindow()
    ? POLL_BURST_MS
    : expectedNextPollMs(minSecondsUntilFire);
  if (newDelayMs !== currentPollDelayMs) {
    const reason = isWithinBurstWindow()
      ? 'burst window lock'
      : `nearest fire in ${Number.isFinite(minSecondsUntilFire) ? minSecondsUntilFire.toFixed(0) + 's' : '∞'}`;
    console.log(`[Monitor] Poll cadence ${currentPollDelayMs/1000}s → ${newDelayMs/1000}s (${reason})`);
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
    consecutiveAlreadyQueued: 0,   // runaway-loop guard — see _handleBotResult
    requeueBlockedReason:     null, // set when guard trips; cleared on a real add/dispatch
    isActive:                driver.is_active ?? true,   // snapshot; kept current by refreshAutoWatches
    scheduledPosition:       driver.scheduled_position ?? null,
    dayPositions:            driver.day_positions ?? null,
    maxAcceptablePosition:   driver.max_acceptable_position ?? null, // null → default to target + 40
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
    earlyJoinDetectedAt: null, // first time we detected driver in queue far ahead of target
    earlyJoinAtPosition: null, // their queue position at that first detection
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
 * Re-arms EVERY watched driver for today's position schedule. Called once
 * per day from the poll loop when the position window opens (3 AM PT) and
 * also exposed for unit tests + the rare ops case where an admin wants to
 * force a re-arm across the fleet.
 *
 * Why this matters: the midnight reset clears `requeueCountToday` and tags
 * carryover drivers, but it does NOT undo `hasBeenSeen` / `positionFiredToday`
 * that get set during 00:00-03:00 if a driver runs the bot manually. Without
 * this 3 AM re-arm, that early run silently blocks the position scheduler
 * from firing at the real target later in the morning.
 *
 * For each driver:
 *   • Drivers observably in V Holding / dispatched / at terminal are tagged
 *     inQueueFromCarryover so the scheduler waits for them to be dropped
 *     before re-firing (same machinery as the midnight-carryover handling).
 *   • Drivers not in queue get a fully clean slate.
 *   • Drivers in 'requeuing' state aren't touched — the bot they're running
 *     will finish on its own.
 *
 * Returns the number of drivers re-armed.
 */
function armPositionWindowForToday(dayKey = todayPT) {
  let armed = 0;
  for (const s of watches.values()) {
    // "Observably queued" means SAN is currently tracking them in some form,
    // OR we've previously observed them in V Holding this session.
    const isObservablyQueued =
      s.state === 'in_queue' ||
      s.state === 'dispatched' ||
      s.state === 'at_terminal' ||
      s.hasBeenSeen === true;

    s.inQueueFromCarryover = isObservablyQueued;
    s.hasBeenSeen          = false;
    s.positionFiredToday   = false;
    s.lastPosDecision      = null;
    s.pendingTrackingId    = null;
    s.manuallyRemovedAt    = null;
    s.terminalSeen         = false;
    s.terminalCheckCount   = 0;
    s.terminalName         = null;
    s.terminalPosition     = null;
    s.atTerminalSince      = null;
    s.earlyJoinDetectedAt  = null;
    s.earlyJoinAtPosition  = null;

    // Don't yank state out from under an in-flight bot.
    if (s.state !== 'requeuing') {
      s.state = s.inQueueFromCarryover ? 'in_queue' : 'watching';
    }
    armed++;
  }

  if (armed > 0) {
    console.log(`[Monitor] Position window armed (${POS_START_HOUR}:00 PT, day ${dayKey}) — ${armed} driver(s) ready for today's schedule`);
    broadcast('position_window_opened', { date: dayKey, armed });
  }
  return armed;
}

/**
 * Re-arms the position scheduler for a single driver. Used by the admin
 * "🎯 Arm" button and the allow-refire endpoint.
 *
 * This is the single-driver equivalent of armPositionWindowForToday() and
 * applies the identical policy: drivers currently observably in the queue
 * are tagged inQueueFromCarryover so the position scheduler waits for them
 * to leave V Holding (via dispatch OR SAN's overnight clear-out) before
 * re-firing at the real target. No need to remove them manually first —
 * the carryover machinery handles it.
 */
function allowRefireToday(driverId) {
  const state = watches.get(driverId);
  if (!state) {
    console.warn(`[Monitor] allowRefireToday: driver ${driverId} not in watches`);
    return false;
  }

  // Same observation check armPositionWindowForToday uses — keeps the two
  // entry points behaviorally identical so an admin clicking "Arm" gets the
  // same outcome as the 3 AM auto-arm would have produced.
  const isObservablyQueued =
    state.state === 'in_queue' ||
    state.state === 'dispatched' ||
    state.state === 'at_terminal' ||
    state.hasBeenSeen === true;

  state.inQueueFromCarryover = isObservablyQueued;
  state.hasBeenSeen          = false;
  state.positionFiredToday   = false;
  state.manuallyRemovedAt    = null;
  state.lastPosDecision      = null;
  state.pendingTrackingId    = null;
  state.terminalSeen         = false;
  state.terminalCheckCount   = 0;
  state.terminalName         = null;
  state.terminalPosition     = null;
  state.atTerminalSince      = null;
  state.earlyJoinDetectedAt  = null;
  state.earlyJoinAtPosition  = null;

  // Don't yank state out from under an in-flight bot.
  if (state.state !== 'requeuing') {
    state.state = state.inQueueFromCarryover ? 'in_queue' : 'watching';
  }

  console.log(`[Monitor] #${state.vehicleNumber} → position scheduler re-armed for today (carryover=${state.inQueueFromCarryover})`);
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
        // Sync schedule + active fields so profile changes take effect within 5 min
        const existing = watches.get(d.id);
        existing.isActive              = d.is_active ?? true;
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
    proxy: proxyHealth.getState(),
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
    `${POLL_NEAR_FIRE_MS / 1000}s near fire / ${POLL_AT_FIRE_MS / 1000}s at fire / ` +
    `${POLL_BURST_MS / 1000}s burst (4:00–5:${String(BURST_WINDOW_END_MIN).padStart(2, '0')} AM PT), ` +
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
  positionWindowArmedForDate = null;
}

/** Seconds until next scheduled poll (uses the current adaptive interval). */
function nextPollIn() { return Math.round(currentPollDelayMs / 1000); }

/**
 * Immediately sync a driver's schedule fields in the in-memory state so that
 * position-scheduler decisions reflect the DB change without waiting for the
 * next AUTO_REFRESH_MS tick (up to 5 minutes).
 *
 * Called by driverController.updateProfile and adminController.updateDriver
 * after a successful schedule update — mirrors the same pattern used by
 * markManuallyRemoved for immediate state propagation.
 *
 * @param {number} driverId
 * @param {{ scheduledPosition, dayPositions, maxAcceptablePosition }} fields
 */
function syncDriverSchedule(driverId, { scheduledPosition, dayPositions, maxAcceptablePosition, isActive } = {}) {
  const state = watches.get(Number(driverId));
  if (!state) return; // driver not currently watched — no-op

  state.scheduledPosition     = scheduledPosition     ?? null;
  state.dayPositions          = dayPositions          ?? null;
  state.maxAcceptablePosition = maxAcceptablePosition ?? null;
  if (isActive !== undefined) state.isActive = isActive;

  console.log(`[Monitor] Schedule synced for #${state.vehicleNumber} (immediate, no refresh wait)`);
}

/**
 * Returns true if the driver has an active position target for today.
 *
 * Used to gate auto-requeue after terminal clearance: drivers who have
 * explicitly disabled today in their per-day schedule should not be
 * re-added to the queue after a dispatch, just as they aren't added in
 * the morning.
 *
 * Returns null (unconstrained) when the driver has no position schedule at
 * all — time-scheduled drivers are always eligible for auto-requeue.
 */
function hasTodayPositionTarget(state) {
  // No position schedule — driver is time-based; no day restriction applies
  if (!state.scheduledPosition && !state.dayPositions) return null;

  if (state.dayPositions) {
    try {
      const dayKey = { Sun:'0',Mon:'1',Tue:'2',Wed:'3',Thu:'4',Fri:'5',Sat:'6' }[
        new Date().toLocaleDateString('en-US', { weekday:'short', timeZone:'America/Los_Angeles' })
      ];
      const dp = JSON.parse(state.dayPositions);
      return !!(dp[dayKey] ?? null);
    } catch {
      return false; // malformed JSON → treat as disabled to be safe
    }
  }

  // Legacy single scheduledPosition — no per-day restriction
  return !!state.scheduledPosition;
}

/**
 * Returns a diagnostic snapshot for every position-scheduled driver currently
 * being watched. Used by the admin "Early Join Alerts" page.
 *
 * Includes:
 *   - Live queue state and position
 *   - Whether an early-join was detected (manual queue join before burst window)
 *   - Whether the position scheduler is still armed or has been blocked
 *
 * Sorted: critical (blocked) first, then warnings (armed but early-join), then
 * normal (waiting / fired / off day).
 */
function getPositionDiagnostics() {
  const DAY_KEY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const todayKey    = DAY_KEY_MAP[todayDayStr];

  const rows = [];

  for (const [driverId, state] of watches.entries()) {
    // Only position-scheduled drivers
    if (!state.scheduledPosition && !state.dayPositions) continue;

    let todayTarget = null;
    if (state.dayPositions) {
      try {
        const dp = JSON.parse(state.dayPositions);
        todayTarget = dp[todayKey] ?? null;
      } catch { todayTarget = null; }
    } else {
      todayTarget = state.scheduledPosition;
    }

    const maxAcceptable = Number.isInteger(state.maxAcceptablePosition)
      ? state.maxAcceptablePosition
      : (todayTarget != null ? todayTarget + 40 : null);

    // Determine scheduler status for display
    let schedulerStatus;
    const earlyJoin = !!state.earlyJoinDetectedAt;

    if (earlyJoin && state.inQueueFromCarryover && !state.positionFiredToday) {
      // Auto-rearm applied: holding as carryover, will fire once driver leaves queue
      schedulerStatus = 'rearmed_waiting';
    } else if (earlyJoin && !state.positionFiredToday) {
      // Early join detected, carryover already cleared, scheduler evaluating normally
      schedulerStatus = 'armed_early_join';
    } else if (earlyJoin && state.positionFiredToday) {
      // Joined early AND eventually positionFiredToday got set (e.g. returned to
      // queue past max). Scheduler done for the day.
      schedulerStatus = 'blocked';
    } else if (state.positionFiredToday) {
      schedulerStatus = 'fired'; // bot ran (or day skipped) — normal completion
    } else if (state.inQueueFromCarryover) {
      schedulerStatus = 'awaiting_carryover';
    } else if (todayTarget === null) {
      schedulerStatus = 'off_day';
    } else {
      schedulerStatus = 'waiting'; // armed, hasn't fired yet
    }

    // Warning level: drives sort order and badge colour
    let warningLevel = 'none';
    if (earlyJoin && state.positionFiredToday) warningLevel = 'critical'; // blocked, nothing to do
    else if (earlyJoin)                         warningLevel = 'warning';  // rearmed/recovering

    const gap = (todayTarget != null && state.earlyJoinAtPosition != null)
      ? todayTarget - state.earlyJoinAtPosition
      : null;

    rows.push({
      driverId,
      vehicleNumber:        state.vehicleNumber,
      driverName:           state.driverName,
      currentState:         state.state,
      currentPosition:      state.currentPosition,
      todayTarget,
      maxAcceptable,
      positionFiredToday:   state.positionFiredToday,
      inQueueFromCarryover: state.inQueueFromCarryover,
      hasBeenSeen:          state.hasBeenSeen,
      schedulerStatus,
      warningLevel,
      earlyJoinDetectedAt:  state.earlyJoinDetectedAt,
      earlyJoinAtPosition:  state.earlyJoinAtPosition,
      earlyJoinGap:         gap,
      lastPosDecision:      state.lastPosDecision,
    });
  }

  // Sort: critical first, then warning, then everything else alphabetically
  const priority = { critical: 0, warning: 1, none: 2 };
  rows.sort((a, b) => {
    const pd = (priority[a.warningLevel] ?? 2) - (priority[b.warningLevel] ?? 2);
    if (pd !== 0) return pd;
    return a.vehicleNumber.localeCompare(b.vehicleNumber);
  });

  return rows;
}

module.exports = {
  startMonitor,
  stopMonitor,
  addWatch,
  removeWatch,
  manualRun,
  markManuallyRemoved,
  syncDriverSchedule,
  allowRefireToday,
  armPositionWindowForToday,
  // Test-only: returns the live in-memory state object for a driver so tests
  // can mutate flags directly. Do NOT use from production code paths —
  // mutating state outside snap() / broadcast() breaks SSE updates.
  _getInternalState: (driverId) => watches.get(driverId),
  getPositionDiagnostics,
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
  _computeMedian:             computeMedian,
  _normaliseLatencySample:    normaliseLatencySample,
  _resetLatencySamples:       () => { botLatencySamples.length = 0; },
};
