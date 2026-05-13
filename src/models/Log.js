const db = require('../config/database');

const TABLE = 'logs';

class Log {
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
   * Admin logs list with driver name and vehicle joined.
   * Supports filtering by driverId, status, date, and free-text search.
   */
  static search({ driverId, status, date, search, limit = 50, offset = 0 } = {}) {
    return db('logs as l')
      .select('l.*', 'd.name as driver_name', 'd.vehicle_number')
      .join('drivers as d', 'l.driver_id', 'd.id')
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
