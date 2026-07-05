'use strict';

const db = require('../config/database');
const TABLE = 'terminal_metrics';

/**
 * Per-terminal dwell & requeue-latency metrics.
 *
 * One INSERT per driver per terminal trip (a handful per driver per day) — far
 * below anything that would stress Postgres. See the migration for column docs.
 */
class TerminalMetric {
  /** Today's date in Pacific Time as YYYY-MM-DD — aligns day boundaries with the operator TZ. */
  static todayPT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  /**
   * Record one completed terminal trip.
   * Best-effort — callers fire-and-forget so a DB hiccup never blocks a requeue.
   */
  static record({
    driverId,
    vehicleNumber,
    terminal,
    requeuePath,
    atTerminalSince,
    terminalLastSeenAt,
    requeuedAt,
    dwellSeconds,
    detectionLagSeconds,
    terminalPosition,
  }) {
    return db(TABLE).insert({
      driver_id:             driverId ?? null,
      vehicle_number:        vehicleNumber,
      terminal:              terminal ?? null,
      requeue_path:          requeuePath,
      at_terminal_since:     atTerminalSince ?? null,
      terminal_last_seen_at: terminalLastSeenAt ?? null,
      requeued_at:           requeuedAt ?? db.fn.now(),
      dwell_seconds:         dwellSeconds ?? null,
      detection_lag_seconds: detectionLagSeconds ?? null,
      terminal_position:     terminalPosition ?? null,
      tracking_date:         TerminalMetric.todayPT(),
    });
  }

  /** Most-recent trips first, joined to the (possibly-deleted) driver for their name. */
  static recent({ limit = 50, offset = 0 } = {}) {
    return db(`${TABLE} as tm`)
      .select(
        'tm.id', 'tm.vehicle_number', 'tm.terminal', 'tm.requeue_path',
        'tm.dwell_seconds', 'tm.detection_lag_seconds', 'tm.terminal_position',
        'tm.at_terminal_since', 'tm.requeued_at', 'tm.tracking_date',
        'd.name as driver_name',
      )
      .leftJoin('drivers as d', 'd.id', 'tm.driver_id')
      .orderBy('tm.requeued_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static async recentCount() {
    const row = await db(TABLE).count('* as count').first();
    return Number(row.count);
  }

  /**
   * Aggregate dwell / detection-lag by terminal over the last N days — the
   * headline "is T1 slower than T2?" numbers for the diagnostics summary.
   */
  static async summaryByTerminal({ days = 7 } = {}) {
    const rows = await db(TABLE)
      .select('terminal')
      .count('* as trips')
      .avg('dwell_seconds as avg_dwell')
      .avg('detection_lag_seconds as avg_lag')
      .whereRaw(`requeued_at >= now() - interval '${parseInt(days, 10)} days'`)
      .groupBy('terminal');

    // Median dwell per terminal — a truer "typical wait" than the mean, which a
    // few very long trips skew. Postgres percentile_cont over the same window.
    const medians = await db(TABLE)
      .select('terminal')
      .select(db.raw('percentile_cont(0.5) within group (order by dwell_seconds) as median_dwell'))
      .whereRaw(`requeued_at >= now() - interval '${parseInt(days, 10)} days'`)
      .whereNotNull('dwell_seconds')
      .groupBy('terminal');

    const medianByTerminal = Object.fromEntries(
      medians.map((m) => [m.terminal ?? 'unknown', m.median_dwell != null ? Math.round(m.median_dwell) : null]),
    );

    return rows.map((r) => ({
      terminal:     r.terminal ?? 'unknown',
      trips:        Number(r.trips),
      avgDwell:     r.avg_dwell != null ? Math.round(r.avg_dwell) : null,
      medianDwell:  medianByTerminal[r.terminal ?? 'unknown'] ?? null,
      avgLag:       r.avg_lag != null ? Math.round(r.avg_lag) : null,
    }));
  }
}

module.exports = TerminalMetric;
