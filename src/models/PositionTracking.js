'use strict';

const db = require('../config/database');
const TABLE = 'position_tracking';

class PositionTracking {
  /**
   * Insert a record when the position-schedule bot fires.
   */
  static async create({ driverId, vehicleNumber, targetPosition, queueSizeAtFire, growthRate, estimatedDrift }) {
    const [row] = await db(TABLE).insert({
      driver_id:        driverId,
      vehicle_number:   vehicleNumber,
      target_position:  targetPosition,
      queue_size_at_fire: queueSizeAtFire,
      growth_rate:      Math.round(growthRate * 100) / 100,
      estimated_drift:  estimatedDrift,
      fired_at:         new Date(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  /**
   * Fill in where the driver actually landed once they appear in the queue.
   */
  static async updateActualPosition(id, actualPosition) {
    await db(TABLE).where({ id }).update({
      actual_position: actualPosition,
      landed_at:       new Date(),
    });
  }

  /**
   * Recent records for the admin accuracy table.
   */
  static recent({ limit = 50, offset = 0 } = {}) {
    return db('position_tracking as pt')
      .select(
        'pt.id', 'pt.vehicle_number', 'pt.target_position',
        'pt.queue_size_at_fire', 'pt.growth_rate', 'pt.estimated_drift',
        'pt.actual_position', 'pt.fired_at', 'pt.landed_at',
        'd.name as driver_name',
      )
      .join('drivers as d', 'd.id', 'pt.driver_id')
      .orderBy('pt.fired_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static recentCount() {
    return db(TABLE).count('* as count').first();
  }

  /**
   * Median landing error from recent records.
   * Returns null if fewer than 5 completed records exist (not enough data to calibrate).
   * A positive value means drivers are landing too far back → bot should fire earlier.
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
