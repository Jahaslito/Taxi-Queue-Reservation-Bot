'use strict';

const db = require('../config/database');
const TABLE = 'position_tracking';

/**
 * Position-scheduler decision tracking.
 *
 * One row per (driver, day) — upserted on every state change so a single record
 * captures the full lifecycle: waiting → fired → completed (or → missed_impossible,
 * skip_already_seen, etc.).
 *
 * Scalability:
 *   • At most one INSERT + a handful of UPDATEs per driver per day (~3 writes max).
 *   • For 1000 drivers × 365 days = 365k rows/year — trivial for Postgres.
 *   • The upsert key (driver_id, tracking_date) is a unique partial index — O(log n)
 *     lookups and conflict resolution stay cheap as the table grows.
 */
class PositionTracking {
  /**
   * Compute today's tracking date in Pacific Time as YYYY-MM-DD.
   * Used as the second half of the upsert key so day boundaries align with
   * the operator's timezone, not UTC.
   */
  static todayPT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  /**
   * Upsert the current scheduler decision for a driver on a given day.
   *
   * Only the columns relevant to the decision are written — the upsert merges
   * with whatever was already there, so a later 'fired' record preserves the
   * 'waiting' history (queue_size_at_fire etc are overwritten with the latest).
   *
   * @returns {Promise<number>} the row id (useful for later updateActualPosition calls)
   */
  static async upsertDecision({
    driverId,
    vehicleNumber,
    trackingDate            = PositionTracking.todayPT(),
    targetPosition,
    maxAcceptablePosition,
    decision,                 // 'waiting' | 'fired' | 'completed' | 'failed'
                              // | 'skip_already_seen' | 'skip_bot_inflight'
                              // | 'missed_impossible'
    decisionReason,
    queueSizeAtFire   = null,
    growthRate        = null,
    estimatedDrift    = null,
    predictedLanding  = null,
    firedAt           = null,
    botDurationMs     = null,
  }) {
    const data = {
      driver_id:               driverId,
      vehicle_number:          vehicleNumber,
      tracking_date:           trackingDate,
      target_position:         targetPosition,
      max_acceptable_position: maxAcceptablePosition,
      decision,
      decision_reason:         decisionReason,
      queue_size_at_fire:      queueSizeAtFire,
      growth_rate:             growthRate != null ? Math.round(growthRate * 100) / 100 : null,
      estimated_drift:         estimatedDrift,
      predicted_landing:       predictedLanding,
      fired_at:                firedAt,
      bot_duration_ms:         botDurationMs,
    };

    // Strip null/undefined values from the MERGE so we don't overwrite existing
    // data with nulls when a later upsert provides only a subset of fields.
    const mergeData = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== null && v !== undefined),
    );

    const [row] = await db(TABLE)
      .insert(data)
      .onConflict(['driver_id', 'tracking_date'])
      .merge(mergeData)
      .returning('id');

    return typeof row === 'object' ? row.id : row;
  }

  /**
   * Fill in where the driver actually landed once they appear in the queue.
   * Called from the poll loop when a position-scheduled driver first shows
   * up in V Holding after the bot fired.
   */
  static async updateActualPosition(id, actualPosition) {
    await db(TABLE).where({ id }).update({
      actual_position: actualPosition,
      landed_at:       new Date(),
      decision:        'completed',
      decision_reason: 'driver_appeared_in_queue',
    });
  }

  /**
   * Records the bot's actual execution time for a fired row.
   * Separate from updateActualPosition because the bot can finish before SAN
   * propagates the queue entry — we capture latency immediately, landing later.
   */
  static async recordBotDuration(id, durationMs) {
    await db(TABLE).where({ id }).update({ bot_duration_ms: durationMs });
  }

  /**
   * Records that the bot failed for a fired row.
   */
  static async markFailed(id, reason) {
    await db(TABLE).where({ id }).update({
      decision:        'failed',
      decision_reason: reason || 'bot_failed',
    });
  }

  /**
   * Recent records for the admin accuracy table.
   * Includes the full decision so admin can see skipped/missed runs too.
   */
  static recent({ limit = 50, offset = 0 } = {}) {
    return db('position_tracking as pt')
      .select(
        'pt.id', 'pt.vehicle_number', 'pt.target_position',
        'pt.max_acceptable_position',
        'pt.queue_size_at_fire', 'pt.growth_rate', 'pt.estimated_drift',
        'pt.predicted_landing', 'pt.actual_position',
        'pt.decision', 'pt.decision_reason',
        'pt.tracking_date', 'pt.fired_at', 'pt.landed_at', 'pt.bot_duration_ms',
        'd.name as driver_name',
      )
      .join('drivers as d', 'd.id', 'pt.driver_id')
      .orderBy('pt.tracking_date', 'desc')
      .orderBy('pt.fired_at',     'desc')
      .limit(limit)
      .offset(offset);
  }

  static recentCount() {
    return db(TABLE).count('* as count').first();
  }

  /**
   * All position-scheduler decisions for a given date (YYYY-MM-DD in PT).
   * One row per driver — the lifecycle of the day captured in a single record.
   * Uses the (driver_id, tracking_date) unique index → O(log n) lookup.
   * Includes the calculated `error` (actual - target) so the UI doesn't have to.
   */
  static byDate(date) {
    return db('position_tracking as pt')
      .select(
        'pt.id',
        'pt.driver_id',
        'pt.vehicle_number',
        'pt.target_position',
        'pt.max_acceptable_position',
        'pt.queue_size_at_fire',
        'pt.growth_rate',
        'pt.estimated_drift',
        'pt.predicted_landing',
        'pt.actual_position',
        'pt.decision',
        'pt.decision_reason',
        'pt.tracking_date',
        'pt.fired_at',
        'pt.landed_at',
        'pt.bot_duration_ms',
        'd.name as driver_name',
        db.raw('CASE WHEN pt.actual_position IS NOT NULL THEN pt.actual_position - pt.target_position END AS error'),
      )
      .join('drivers as d', 'd.id', 'pt.driver_id')
      .where('pt.tracking_date', date)
      .orderBy('d.name', 'asc');
  }

  /**
   * Aggregate stats for a given date — counts by decision plus median error
   * and median bot duration. Runs a single grouped query, not one per metric.
   */
  static async dailySummary(date) {
    const rows = await db(TABLE)
      .select('decision')
      .count('* as count')
      .where('tracking_date', date)
      .groupBy('decision');

    const counts = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      counts[r.decision || 'unknown'] = n;
      total += n;
    }

    // Errors and durations — pulled in one query each and computed in JS
    // (cheap since these are small daily slices, typically <100 rows).
    const completed = await db(TABLE)
      .select(
        db.raw('actual_position - target_position AS error'),
        'bot_duration_ms',
      )
      .where('tracking_date', date)
      .whereNotNull('actual_position');

    const median = (arr) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };

    return {
      date,
      total,
      counts,
      completed:           completed.length,
      medianError:         median(completed.map(r => Number(r.error))),
      medianBotDurationMs: median(completed.map(r => r.bot_duration_ms).filter(Number.isFinite)),
    };
  }

  /**
   * Median landing error from recent completed fires.
   * Returns null if fewer than 5 completed records exist (not enough data to
   * calibrate). A positive value means drivers are landing too far back →
   * bot should fire earlier.
   */
  static async medianRecentError(limit = 30) {
    const rows = await db(TABLE)
      .select(db.raw('actual_position - target_position AS error'))
      .whereNotNull('actual_position')
      .orderBy('fired_at', 'desc')
      .limit(limit);

    if (rows.length < 5) return null;

    const errors = rows.map(r => Number(r.error)).sort((a, b) => a - b);
    const mid    = Math.floor(errors.length / 2);
    return errors.length % 2 === 0
      ? (errors[mid - 1] + errors[mid]) / 2
      : errors[mid];
  }
}

module.exports = PositionTracking;
