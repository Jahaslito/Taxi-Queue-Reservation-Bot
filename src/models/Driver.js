const db = require('../config/database');

const TABLE = 'drivers';

// Columns safe to return to API consumers (excludes credentials)
const PUBLIC_FIELDS = [
  'id', 'name', 'phone', 'email', 'san_username',
  'vehicle_number', 'scheduled_time', 'is_active', 'notes', 'created_at',
];

class Driver {
  /** Single driver by ID — public fields only */
  static findById(id) {
    return db(TABLE).select(PUBLIC_FIELDS).where({ id }).first();
  }

  /** Single driver by ID — includes hashed app_password and encrypted san_password */
  static findByIdWithCredentials(id) {
    return db(TABLE).where({ id }).first();
  }

  static findByEmail(email) {
    return db(TABLE).where({ email }).first();
  }

  static findByVehicleNumber(vehicleNumber) {
    return db(TABLE).where({ vehicle_number: vehicleNumber }).first();
  }

  /** Used by the scheduler — returns all columns so san_password is available for decryption */
  static findActiveByScheduledTime(scheduledTime) {
    return db(TABLE).where({ is_active: true, scheduled_time: scheduledTime });
  }

  static async create(data) {
    const [driver] = await db(TABLE).insert(data).returning(PUBLIC_FIELDS);
    return driver;
  }

  static async update(id, data) {
    const [driver] = await db(TABLE)
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() })
      .returning(PUBLIC_FIELDS);
    return driver;
  }

  static async deactivate(id) {
    await db(TABLE)
      .where({ id })
      .update({ is_active: false, updated_at: db.fn.now() });
  }

  static count({ activeOnly = false } = {}) {
    return db(TABLE)
      .modify((q) => { if (activeOnly) q.where('is_active', true); })
      .count('* as count')
      .first();
  }

  /**
   * Full-text search across drivers with their latest log status joined.
   * Used by the admin drivers list endpoint.
   */
  static search({ search, activeOnly = false } = {}) {
    const latestLogSubquery = db('logs')
      .select('id')
      .whereRaw('driver_id = d.id')
      .orderBy('triggered_at', 'desc')
      .limit(1);

    return db('drivers as d')
      .select(
        'd.id', 'd.name', 'd.phone', 'd.email', 'd.san_username',
        'd.vehicle_number', 'd.scheduled_time', 'd.is_active', 'd.notes', 'd.created_at',
        'l.status         as last_status',
        'l.queue_position as last_position',
        'l.triggered_at   as last_run',
      )
      .leftJoin('logs as l', 'l.id', latestLogSubquery)
      .modify((q) => {
        if (search) {
          q.where((builder) => {
            builder
              .whereILike('d.name',           `%${search}%`)
              .orWhereILike('d.vehicle_number', `%${search}%`)
              .orWhereILike('d.san_username',   `%${search}%`);
          });
        }
        if (activeOnly) q.where('d.is_active', true);
      })
      .orderBy('d.scheduled_time', 'asc')
      .orderBy('d.name',           'asc');
  }

  /** Counts active drivers grouped by scheduled_time for the overview dashboard */
  static scheduleBreakdown() {
    return db(TABLE)
      .select('scheduled_time')
      .count('* as count')
      .where('is_active', true)
      .groupBy('scheduled_time')
      .orderBy('scheduled_time', 'asc');
  }
}

module.exports = Driver;
