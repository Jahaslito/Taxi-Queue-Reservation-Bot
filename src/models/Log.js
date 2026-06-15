const db = require('../config/database');

const TABLE = 'logs';

// ─── Trigger-type taxonomy ────────────────────────────────────────────────────
// ADD triggers put a driver INTO the queue (a successful one means the driver is
// now in V Holding). REMOVE triggers take them OUT — a successful remove means
// the driver is NOT in queue. The two MUST NOT be conflated: deriving "the driver
// is in queue" (hasBeenSeen) from a REMOVE-type success is exactly the bug that
// stranded the whole fleet on 2026-06-15 (a midnight carryover_cleanup success
// was read on restart as "already in queue" → skipped at target). See
// CARRYOVER_MARKER below and monitorService.addWatch().
const ADD_TRIGGER_TYPES = ['position_schedule', 'monitor_requeue', 'scheduled', 'manual'];
// Synthetic, non-bot log written once per leftover at the midnight reset. It is
// the durable record that "this driver was a carryover leftover today", so the
// carryover protection can be rebuilt after a restart between midnight and the
// morning fire window (when neither the reset nor the 3 AM re-arm runs again).
const CARRYOVER_MARKER = 'carryover_marker';
// A successful add log in either of these statuses means the driver is in queue.
const SEEN_STATUSES = ['success', 'already_queued'];

class Log {
  static get ADD_TRIGGER_TYPES() { return ADD_TRIGGER_TYPES; }
  static get CARRYOVER_MARKER()  { return CARRYOVER_MARKER; }
  static get SEEN_STATUSES()     { return SEEN_STATUSES; }

  static async create(data) {
    const [row] = await db(TABLE).insert(data).returning('id');
    return row.id;
  }

  static async update(id, data) {
    await db(TABLE).where({ id }).update(data);
  }

  static findByDriver(driverId, { limit = 20, offset = 0 } = {}) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .orderBy('triggered_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static countByDriver(driverId) {
    return db(TABLE).where({ driver_id: driverId }).count('* as count').first();
  }

  /**
   * Returns today's latest log for a driver.
   * "Today" is evaluated in Pacific Time to match the scheduler's timezone.
   */
  static findTodayLatest(driverId, today) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .orderBy('triggered_at', 'desc')
      .first();
  }

  /**
   * Today's latest ADD-type log for a driver (the queue-entry actions only —
   * see ADD_TRIGGER_TYPES). Used to rebuild `hasBeenSeen` on restart WITHOUT
   * mistaking a remove for an add. A REMOVE-type log (carryover_cleanup /
   * manual_remove) is never returned here, so a successful removal can never
   * be read back as "the driver is in queue".
   */
  static findTodayLatestAdd(driverId, today) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .whereIn('trigger_type', ADD_TRIGGER_TYPES)
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .orderBy('triggered_at', 'desc')
      .first();
  }

  /** Did a driver have a carryover marker written at today's midnight reset? */
  static async wasCarryoverToday(driverId, today) {
    const row = await db(TABLE)
      .where({ driver_id: driverId, trigger_type: CARRYOVER_MARKER })
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .first();
    return !!row;
  }

  /**
   * Used by the scheduler to skip drivers already successfully queued today.
   * "Today" is evaluated in Pacific Time.
   */
  static findSuccessToday(driverId, today) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .whereIn('status', ['success', 'already_queued'])
      .first();
  }

  /**
   * Batch version of findSuccessToday — one query for any number of drivers.
   * Returns a Set of driverIds that have already been successfully queued today.
   * Replaces N sequential queries in the cron tick with a single WHERE IN.
   */
  static async findSuccessTodayBatch(driverIds, today) {
    if (!driverIds.length) return new Set();
    const rows = await db(TABLE)
      .whereIn('driver_id', driverIds)
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .whereIn('status', ['success', 'already_queued'])
      .select('driver_id');
    return new Set(rows.map(r => r.driver_id));
  }

  /**
   * Admin logs list with driver name and vehicle joined.
   * Supports filtering by driverId, status, date, and free-text search.
   */
  static search({ driverId, status, date, search, limit = 50, offset = 0 } = {}) {
    return db('logs as l')
      .select('l.*', 'd.name as driver_name', 'd.vehicle_number')
      .join('drivers as d', 'l.driver_id', 'd.id')
      .whereNot('l.trigger_type', CARRYOVER_MARKER) // internal bookkeeping, not a real run
      .modify((q) => {
        if (driverId) q.where('l.driver_id', driverId);
        if (status)   q.where('l.status', status);
        if (date)     q.whereRaw('DATE(l.triggered_at) = ?', [date]);
        if (search) {
          q.where((builder) => {
            builder
              .whereILike('d.name',           `%${search}%`)
              .orWhereILike('d.vehicle_number', `%${search}%`);
          });
        }
      })
      .orderBy('l.triggered_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  /** Count matching logs — mirrors the filters from search() for accurate pagination totals */
  static count({ driverId, status, date, search } = {}) {
    return db('logs as l')
      .join('drivers as d', 'l.driver_id', 'd.id')
      .whereNot('l.trigger_type', CARRYOVER_MARKER) // mirror search()
      .modify((q) => {
        if (driverId) q.where('l.driver_id', driverId);
        if (status)   q.where('l.status', status);
        if (date)     q.whereRaw('DATE(l.triggered_at) = ?', [date]);
        if (search) {
          q.where((builder) => {
            builder
              .whereILike('d.name',           `%${search}%`)
              .orWhereILike('d.vehicle_number', `%${search}%`);
          });
        }
      })
      .count('* as count')
      .first();
  }

  /**
   * Count how many monitor_requeue logs a driver has today.
   * Used on startup to restore requeueCountToday after a restart.
   */
  static findTodayMonitorRequeues(driverId, today) {
    return db(TABLE)
      .where({ driver_id: driverId, trigger_type: 'monitor_requeue', status: 'success' })
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .count('* as count')
      .first();
  }

  static findTodayByTriggerType(driverId, triggerType, today) {
    return db(TABLE)
      .where({ driver_id: driverId, trigger_type: triggerType })
      .whereRaw("DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?", [today])
      .first();
  }

  /**
   * Batch-load all startup context for many drivers in 3 parallel queries.
   * Replaces the O(n × 3) sequential per-driver queries in watchAllActive().
   *
   * Returns:
   *   latestAddByDriver     Map<driverId, log>    — most recent ADD-type log today
   *                                                 (drives hasBeenSeen; a remove
   *                                                 success is deliberately excluded)
   *   requeueCountByDriver  Map<driverId, number> — successful monitor_requeue count today
   *   positionLogByDriver   Map<driverId, log>    — most recent position_schedule log today
   *   carryoverByDriver     Set<driverId>         — drivers tagged carryover at midnight today
   */
  static async loadTodayContext(driverIds, today) {
    if (!driverIds.length) {
      return {
        latestAddByDriver:    new Map(),
        requeueCountByDriver: new Map(),
        positionLogByDriver:  new Map(),
        carryoverByDriver:    new Set(),
      };
    }

    const dateFilter = "DATE(triggered_at AT TIME ZONE 'America/Los_Angeles') = ?";

    const [addLogs, requeues, positionLogs, carryoverMarkers] = await Promise.all([
      // ADD-type only: a remove success must never restore hasBeenSeen.
      db(TABLE)
        .whereIn('driver_id', driverIds)
        .whereIn('trigger_type', ADD_TRIGGER_TYPES)
        .whereRaw(dateFilter, [today])
        .orderBy('triggered_at', 'desc'),

      db(TABLE)
        .whereIn('driver_id', driverIds)
        .where({ trigger_type: 'monitor_requeue', status: 'success' })
        .whereRaw(dateFilter, [today])
        .groupBy('driver_id')
        .select('driver_id')
        .count('* as count'),

      db(TABLE)
        .whereIn('driver_id', driverIds)
        .where({ trigger_type: 'position_schedule' })
        .whereRaw(dateFilter, [today])
        .orderBy('triggered_at', 'desc'),

      db(TABLE)
        .whereIn('driver_id', driverIds)
        .where({ trigger_type: CARRYOVER_MARKER })
        .whereRaw(dateFilter, [today])
        .distinct('driver_id'),
    ]);

    // First occurrence per driver_id = most recent (rows are ordered desc)
    const latestAddByDriver = new Map();
    for (const row of addLogs) {
      if (!latestAddByDriver.has(row.driver_id)) latestAddByDriver.set(row.driver_id, row);
    }

    const requeueCountByDriver = new Map();
    for (const row of requeues) {
      requeueCountByDriver.set(row.driver_id, parseInt(row.count, 10));
    }

    const positionLogByDriver = new Map();
    for (const row of positionLogs) {
      if (!positionLogByDriver.has(row.driver_id)) positionLogByDriver.set(row.driver_id, row);
    }

    const carryoverByDriver = new Set();
    for (const row of carryoverMarkers) carryoverByDriver.add(row.driver_id);

    return { latestAddByDriver, requeueCountByDriver, positionLogByDriver, carryoverByDriver };
  }

  static countByStatusAndDate(status, date) {
    return db(TABLE)
      .where({ status })
      .whereRaw('DATE(triggered_at) = ?', [date])
      .count('* as count')
      .first();
  }

  static countByDate(date) {
    return db(TABLE)
      .whereRaw('DATE(triggered_at) = ?', [date])
      .count('* as count')
      .first();
  }

  static countAllByStatus(status) {
    return db(TABLE).where({ status }).count('* as count').first();
  }
}

module.exports = Log;
