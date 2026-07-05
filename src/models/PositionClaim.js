const db = require('../config/database');

const TABLE = 'position_claims';

class PositionClaim {
  /**
   * Atomically replace all position claims for a driver.
   *
   * Deletes the driver's existing claims, then inserts the new set — both
   * inside one transaction so they are never partially applied.
   *
   * Positions are NOT exclusive: any number of drivers may hold the same
   * (day, position) slot, so this never rejects on conflict. The table is
   * just a per-driver record of intended slots.
   *
   * @param {number} driverId        — driver whose claims to replace
   * @param {object} dayPositionsObj — { "0": 200, "5": null, "6": 150, … }
   *                                   null / falsy values mean "no claim that day"
   * @param {object} [trx]           — optional Knex transaction; creates one if omitted
   */
  static async setForDriver(driverId, dayPositionsObj, trx) {
    const rows = Object.entries(dayPositionsObj)
      .filter(([, pos]) => pos !== null && pos !== undefined && Number(pos) > 0)
      .map(([day, pos]) => ({
        driver_id:   driverId,
        day_of_week: parseInt(day, 10),
        position:    parseInt(pos, 10),
      }));

    const run = async (t) => {
      // Atomically replace the driver's claims. No exclusivity check —
      // shared slots are allowed, so the insert can never conflict.
      await t(TABLE).where({ driver_id: driverId }).delete();
      if (rows.length > 0) {
        await t(TABLE).insert(rows);
      }
    };

    if (trx) {
      await run(trx);
    } else {
      await db.transaction(run);
    }
  }

  /**
   * Remove ALL claims for a driver — used when a driver is deactivated so the
   * slots become available for other drivers immediately.
   *
   * @param {number} driverId
   * @param {object} [trx]    — optional Knex transaction
   */
  static async clearForDriver(driverId, trx) {
    await (trx || db)(TABLE).where({ driver_id: driverId }).delete();
  }

  /**
   * Kept for the admin pre-save check endpoint. Positions are no longer
   * exclusive, so there is never a conflict — always resolves to null.
   *
   * @returns {Promise<null>}
   */
  static async checkConflicts() {
    return null;
  }

  /** Returns all claims for a driver as { day_of_week, position } rows. */
  static getForDriver(driverId) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .select('day_of_week', 'position')
      .orderBy('day_of_week');
  }
}

module.exports = PositionClaim;
