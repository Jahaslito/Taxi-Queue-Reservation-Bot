/**
 * Retention sweeps for the two unbounded tables. Wired into server.js at boot;
 * self-gates on RETENTION_ENABLED (default off) so wiring is a no-op until the
 * env flips.
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this exists: `queue_snapshots` (one row per poll — up to ~18k on a storm
 * day at the 1 s burst cadence) and `logs` (one row per requeue/event) grow
 * without bound. Nothing prunes them today. That's the ONLY long-term risk to
 * the 1 GB Postgres cap set 2026-07-28 (see docker-compose db service): the
 * tables don't spike, they ramp — bigger sorts (medianRecentError's un-indexed
 * ORDER BY fired_at), bigger hash joins (the admin report's DATE()-wrapped
 * logs×position_tracking predicate), and heavier autovacuum over months.
 *
 * A knex *migration* runs once, so it can't provide ONGOING retention — this is
 * a daily sweep instead. It is deliberately conservative:
 *   • DELETEs only rows OLDER than the retention window (never recent data).
 *   • Batched (BATCH rows per statement) so a single DELETE can't hold a long
 *     lock or balloon WAL — matters on the 1 GB-capped db.
 *   • Age columns are already indexed (queue_snapshots.observed_at DESC,
 *     logs.triggered_at) so each batch is an index range delete, not a seq scan.
 *   • position_tracking is left ALONE: it's one small row per driver per day and
 *     feeds bias/accuracy history — pruning it would blind medianRecentError.
 *
 * ⚠️ Retention windows keep enough history for the analytics that read these
 * tables: the day-of-week storm-profile study spans ~9 weeks (~63 days), so 90
 * days is the floor. Tune via env; 0 disables a table's sweep entirely.
 *
 * ON/OFF is pure env: RETENTION_ENABLED (default 'false'). start() is safe to
 * call unconditionally at boot — it self-gates on the flag and no-ops (with a
 * log) when disabled, so flipping retention on/off is an env change + container
 * recreate, NO code deploy. Per-table windows can also be zeroed independently
 * (RETENTION_*_DAYS=0) without turning the whole sweep off.
 */

const db = require('../config/database');

const DAY_MS = 24 * 60 * 60 * 1000;

// Master on/off — pure env, default OFF so nothing prunes until you opt in.
const RETENTION_ENABLED = (process.env.RETENTION_ENABLED ?? 'false') === 'true';

// Retention windows (days). 0 disables that table's sweep. Floor of 90 keeps the
// 9-week storm-profile analytics intact — do not drop below that without also
// shortening those studies.
const QUEUE_SNAPSHOT_RETENTION_DAYS = parseInt(process.env.RETENTION_QUEUE_SNAPSHOTS_DAYS ?? '90', 10);
const LOG_RETENTION_DAYS            = parseInt(process.env.RETENTION_LOGS_DAYS            ?? '90', 10);

// Rows per DELETE statement. Small enough to keep locks/WAL short; large enough
// that a full day's ~18k snapshots clear in a handful of statements.
const BATCH = parseInt(process.env.RETENTION_BATCH_SIZE ?? '5000', 10);

// How often the sweep runs while the process is up. Default MONTHLY (~30 d): the
// retention window is a MOVING 90-day line, so the sweep must repeat to stay
// bounded — but the tables grow slowly, so at monthly cadence the table simply
// carries at most ~30 extra days beyond the window (~120 d worst case), still far
// under the 1 GB cap. Each run is cheap, batched, and idempotent, so tune freely.
const SWEEP_INTERVAL_MS = parseInt(process.env.RETENTION_SWEEP_INTERVAL_MS ?? String(30 * DAY_MS), 10);

/**
 * Delete rows older than `retentionDays` from `table`, comparing `timeColumn`,
 * in batches of BATCH. Uses ctid batching so it needs no knowledge of the PK and
 * never rescans rows it just deleted. Returns the total number of rows removed.
 * Pure-ish: all effects are DELETEs on old rows; safe to call repeatedly.
 */
async function pruneTable(table, timeColumn, retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return 0; // disabled
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  let totalDeleted = 0;

  // Loop batch-by-batch until a batch deletes fewer than BATCH rows (i.e. we've
  // drained everything older than the cutoff). Each statement is its own small
  // transaction so locks are released between batches.
  for (;;) {
    const result = await db.raw(
      `DELETE FROM ?? WHERE ctid IN (
         SELECT ctid FROM ?? WHERE ?? < ? LIMIT ?
       )`,
      [table, table, timeColumn, cutoff, BATCH],
    );
    const deleted = result.rowCount ?? 0;
    totalDeleted += deleted;
    if (deleted < BATCH) break;
  }

  if (totalDeleted > 0) {
    console.log(`[Retention] ${table}: pruned ${totalDeleted} row(s) older than ${retentionDays}d (before ${cutoff.toISOString()})`);
  }
  return totalDeleted;
}

/**
 * Run one full retention pass across both unbounded tables. Failures are logged
 * and swallowed per table so one bad sweep can't crash the process or block the
 * other table. Returns { queueSnapshots, logs } counts for observability/tests.
 */
async function sweep() {
  const out = { queueSnapshots: 0, logs: 0 };
  try {
    out.queueSnapshots = await pruneTable('queue_snapshots', 'observed_at', QUEUE_SNAPSHOT_RETENTION_DAYS);
  } catch (err) {
    console.error('[Retention] queue_snapshots sweep failed:', err.message);
  }
  try {
    out.logs = await pruneTable('logs', 'triggered_at', LOG_RETENTION_DAYS);
  } catch (err) {
    console.error('[Retention] logs sweep failed:', err.message);
  }
  return out;
}

let timer = null;

// Node timers use a 32-bit delay; anything larger is clamped to 1 ms. Stay under it.
const MAX_TIMER_MS = 2 ** 31 - 1; // 2147483647 ms ≈ 24.8 days

/**
 * setTimeout that honours delays beyond the 32-bit limit by chaining safe chunks.
 * Returns the current timer handle (reassigned to `timer` as it re-chains, so a
 * single clearTimeout on the latest handle cancels it). `unref()` so a pending
 * sweep never keeps the process alive.
 */
function scheduleLong(delayMs, fn) {
  if (delayMs > MAX_TIMER_MS) {
    const t = setTimeout(() => { timer = scheduleLong(delayMs - MAX_TIMER_MS, fn); }, MAX_TIMER_MS);
    t.unref();
    return t;
  }
  const t = setTimeout(fn, delayMs);
  t.unref();
  return t;
}

/** Start the sweep loop. Idempotent. Runs one sweep ~60 s after boot, then every
 *  SWEEP_INTERVAL_MS. `unref()` so the timer never keeps the process alive. */
function start() {
  if (!RETENTION_ENABLED) {
    console.log('[Retention] disabled (RETENTION_ENABLED=false) — no sweeps scheduled');
    return;
  }
  if (timer) return;
  // Small initial delay so a boot storm (migrations, warmers) settles first, then
  // repeat every SWEEP_INTERVAL_MS. NOTE: setInterval/setTimeout take a 32-bit
  // delay (max MAX_TIMER_MS ≈ 24.8 d) and SILENTLY clamp anything larger to 1 ms
  // — which at a 30-day interval would fire the sweep continuously. scheduleLong
  // splits an over-long delay into safe chunks so monthly (and beyond) is honest.
  const runSweep = () => sweep().catch((e) => console.error('[Retention] sweep:', e.message));
  const loop = () => { runSweep(); timer = scheduleLong(SWEEP_INTERVAL_MS, loop); };
  timer = scheduleLong(60_000, loop);
  console.log(`[Retention] scheduled every ${(SWEEP_INTERVAL_MS / DAY_MS).toFixed(1)}d — ` +
    `queue_snapshots ${QUEUE_SNAPSHOT_RETENTION_DAYS}d, logs ${LOG_RETENTION_DAYS}d, batch ${BATCH}`);
}

function stop() { if (timer) { clearTimeout(timer); timer = null; } }

module.exports = { start, stop, sweep, _pruneTable: pruneTable };
