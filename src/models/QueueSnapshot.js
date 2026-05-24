'use strict';

const db = require('../config/database');
const TABLE = 'queue_snapshots';

/**
 * Time-series record of the V-Holding queue plus the scheduler's internal
 * prediction state at each poll tick.
 *
 * Designed to be called fire-and-forget from poll() — never blocks, never
 * throws to the caller. A failed insert is logged but won't affect scheduling.
 *
 * Storage budget:
 *   ~80 bytes/row × 3500 polls/day ≈ 280 KB/day, ~100 MB/year. Trivial.
 */
class QueueSnapshot {
  /**
   * Insert a snapshot row. All numeric fields default to null/0 if not
   * provided — caller doesn't need to populate the full set.
   */
  static record({
    waitingCount,
    dispatchedCount      = 0,
    notAuthorizedCount   = 0,
    lastPollRate         = null,
    shortWindowRate      = null,
    smoothedGrowthRate   = null,
    effectiveGrowthRate  = null,
    botP95Ms             = null,
    botLatencySamples    = null,
    biasCorrection       = null,
    pollIntervalMs       = null,
  } = {}) {
    // Compute PT day/hour/minute via formatToParts — gives structured fields
    // instead of relying on a particular toLocaleString string layout.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday:  'short',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    }).formatToParts(new Date());

    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const get = (type) => parts.find(p => p.type === type)?.value;
    const dayAbbr = get('weekday');
    const hourStr = get('hour');
    const minStr  = get('minute');

    return db(TABLE).insert({
      waiting_count:          waitingCount,
      dispatched_count:       dispatchedCount,
      not_authorized_count:   notAuthorizedCount,
      last_poll_rate:         lastPollRate         != null ? roundTo3(lastPollRate)         : null,
      short_window_rate:      shortWindowRate      != null ? roundTo3(shortWindowRate)      : null,
      smoothed_growth_rate:   smoothedGrowthRate   != null ? roundTo3(smoothedGrowthRate)   : null,
      effective_growth_rate:  effectiveGrowthRate  != null ? roundTo3(effectiveGrowthRate)  : null,
      bot_p95_ms:             botP95Ms,
      bot_latency_samples:    botLatencySamples,
      bias_correction:        biasCorrection       != null ? Math.round(biasCorrection * 100) / 100 : null,
      poll_interval_ms:       pollIntervalMs,
      day_of_week:            dayMap[dayAbbr] ?? null,
      hour_pt:                parseInt(hourStr, 10),
      minute_pt:              parseInt(minStr,  10),
    });
  }

  /**
   * Recent snapshots — used by the admin UI for a time-series chart.
   */
  static recent({ limit = 200 } = {}) {
    return db(TABLE)
      .select('*')
      .orderBy('observed_at', 'desc')
      .limit(limit);
  }

  /**
   * Growth rate aggregated by (day_of_week, hour_pt, position_band).
   * The core query for finding burst positions.
   *
   * Returns rows like:
   *   { day_of_week: 6, hour_pt: 5, position_band: '90-120', avg_growth_per_min: 25 }
   *
   * Run after a few weeks of data to find the bursts.
   */
  static async growthByPosition({ dayOfWeek = null, hourPT = null, bandSize = 30 } = {}) {
    let qb = db(TABLE)
      .select(
        'day_of_week',
        'hour_pt',
        db.raw(`width_bucket(waiting_count, 0, 500, ?) AS position_band`, [Math.ceil(500 / bandSize)]),
        db.raw(`AVG(effective_growth_rate * 60) AS avg_growth_per_min`),
        db.raw(`COUNT(*) AS sample_count`),
      )
      .whereNotNull('effective_growth_rate');

    if (dayOfWeek !== null) qb = qb.where('day_of_week', dayOfWeek);
    if (hourPT    !== null) qb = qb.where('hour_pt',     hourPT);

    return qb.groupBy('day_of_week', 'hour_pt', 'position_band')
             .orderBy(['day_of_week', 'hour_pt', 'position_band']);
  }
}

function roundTo3(n) { return Math.round(n * 1000) / 1000; }

module.exports = QueueSnapshot;
