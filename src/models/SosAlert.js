const db = require('../config/database');

const TABLE = 'sos_alerts';
const HISTORY_TABLE = 'sos_location_history';

const STATUS = {
  ACTIVE:       'active',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED:     'resolved',
};

const PUBLIC_FIELDS = [
  'id', 'driver_id', 'status',
  'initial_lat', 'initial_lng', 'initial_accuracy',
  'latest_lat', 'latest_lng', 'latest_accuracy', 'latest_location_at',
  'place_name',
  'live_tracking', 'message',
  'acknowledged_by', 'acknowledged_at',
  'resolved_by', 'resolved_at', 'resolution_reason',
  'created_at', 'updated_at',
];

class SosAlert {
  static async create({ driverId, lat, lng, accuracy, message, liveTracking = false }) {
    const now = new Date();
    const row = {
      driver_id:        driverId,
      status:           STATUS.ACTIVE,
      initial_lat:      lat ?? null,
      initial_lng:      lng ?? null,
      initial_accuracy: accuracy ?? null,
      latest_lat:       lat ?? null,
      latest_lng:       lng ?? null,
      latest_accuracy:  accuracy ?? null,
      latest_location_at: lat != null ? now : null,
      live_tracking:    Boolean(liveTracking),
      message:          message || null,
    };

    const [alert] = await db(TABLE).insert(row).returning(PUBLIC_FIELDS);

    if (lat != null && lng != null) {
      await db(HISTORY_TABLE).insert({
        alert_id: alert.id,
        lat, lng, accuracy: accuracy ?? null,
        recorded_at: now,
      });
    }
    return alert;
  }

  static async appendLocation(id, { lat, lng, accuracy }) {
    const now = new Date();
    await db.transaction(async (trx) => {
      await trx(TABLE)
        .where({ id })
        .update({
          latest_lat: lat,
          latest_lng: lng,
          latest_accuracy: accuracy ?? null,
          latest_location_at: now,
          updated_at: now,
        });
      await trx(HISTORY_TABLE).insert({
        alert_id: id, lat, lng, accuracy: accuracy ?? null, recorded_at: now,
      });
    });
    return this.findById(id);
  }

  static async setPlaceName(id, placeName) {
    await db(TABLE).where({ id }).update({
      place_name: placeName || null,
      updated_at: db.fn.now(),
    });
    return this.findByIdWithDriver(id);
  }

  static async setLiveTracking(id, enabled) {
    await db(TABLE).where({ id }).update({
      live_tracking: Boolean(enabled),
      updated_at: db.fn.now(),
    });
    return this.findById(id);
  }

  static async acknowledge(id, adminId) {
    const [alert] = await db(TABLE)
      .where({ id })
      .where('status', STATUS.ACTIVE)
      .update({
        status:          STATUS.ACKNOWLEDGED,
        acknowledged_by: adminId,
        acknowledged_at: db.fn.now(),
        updated_at:      db.fn.now(),
      })
      .returning(PUBLIC_FIELDS);
    return alert; // undefined if already acknowledged/resolved — caller decides
  }

  static async resolve(id, adminId) {
    const [alert] = await db(TABLE)
      .where({ id })
      .whereNot('status', STATUS.RESOLVED)
      .update({
        status:            STATUS.RESOLVED,
        resolved_by:       adminId,
        resolved_at:       db.fn.now(),
        resolution_reason: 'admin_resolved',
        live_tracking:     false,
        updated_at:        db.fn.now(),
      })
      .returning(PUBLIC_FIELDS);
    return alert;
  }

  static async cancelByDriver(id, driverId) {
    const [alert] = await db(TABLE)
      .where({ id, driver_id: driverId })
      .whereNot('status', STATUS.RESOLVED)
      .update({
        status:            STATUS.RESOLVED,
        resolved_at:       db.fn.now(),
        resolution_reason: 'driver_cancelled',
        live_tracking:     false,
        updated_at:        db.fn.now(),
      })
      .returning(PUBLIC_FIELDS);
    return alert;
  }

  static findById(id) {
    return db(TABLE).select(PUBLIC_FIELDS).where({ id }).first();
  }

  static findByIdWithDriver(id) {
    return db(`${TABLE} as a`)
      .select(
        ...PUBLIC_FIELDS.map((f) => `a.${f}`),
        'd.name as driver_name',
        'd.phone as driver_phone',
        'd.email as driver_email',
        'd.vehicle_number as driver_vehicle_number',
      )
      .leftJoin('drivers as d', 'd.id', 'a.driver_id')
      .where('a.id', id)
      .first();
  }

  /** Latest active+acknowledged alert for this driver, if any (used to prevent dupes). */
  static findOpenForDriver(driverId) {
    return db(TABLE)
      .select(PUBLIC_FIELDS)
      .where({ driver_id: driverId })
      .whereIn('status', [STATUS.ACTIVE, STATUS.ACKNOWLEDGED])
      .orderBy('id', 'desc')
      .first();
  }

  /** Admin list — newest first, with driver info joined. */
  static listRecent({ limit = 50, offset = 0, status } = {}) {
    return db(`${TABLE} as a`)
      .select(
        ...PUBLIC_FIELDS.map((f) => `a.${f}`),
        'd.name as driver_name',
        'd.phone as driver_phone',
        'd.email as driver_email',
        'd.vehicle_number as driver_vehicle_number',
      )
      .leftJoin('drivers as d', 'd.id', 'a.driver_id')
      .modify((q) => { if (status) q.where('a.status', status); })
      .orderBy('a.created_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static countOpen() {
    return db(TABLE)
      .whereIn('status', [STATUS.ACTIVE, STATUS.ACKNOWLEDGED])
      .count('* as count')
      .first();
  }

  /** Full GPS trail for an alert (used by the admin detail view for the map polyline). */
  static getLocationHistory(alertId, { limit = 500 } = {}) {
    return db(HISTORY_TABLE)
      .select('lat', 'lng', 'accuracy', 'recorded_at')
      .where({ alert_id: alertId })
      .orderBy('recorded_at', 'asc')
      .limit(limit);
  }
}

SosAlert.STATUS = STATUS;
module.exports = SosAlert;
