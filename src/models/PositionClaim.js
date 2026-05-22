const db = require('../config/database');

const TABLE = 'position_claims';

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

class PositionClaim {
  /**
   * Atomically replace all position claims for a driver.
   *
   * Deletes the driver's existing claims, then inserts the new set — both
   * inside one transaction so they are never partially applied.
   *
   * The UNIQUE constraint on (day_of_week, position) causes a PG error 23505
   * if another driver already owns any of the requested slots.  Callers should
   * catch that and surface a 409 with a human-readable message via formatConflict().
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
      // Pre-flight conflict check — runs before any modifications so we can
      // identify the exact conflicting slot and surface a readable message.
      // Uses the unique index on (day_of_week, position) → O(log n) per slot.
      // The outer unique constraint is still the authoritative guard against races.
      if (rows.length > 0) {
        const conflict = await t(TABLE)
          .where((q) => {
            rows.forEach((row) => {
              q.orWhere({ day_of_week: row.day_of_week, position: row.position });
            });
          })
          .whereNot({ driver_id: driverId })
          .select('day_of_week', 'position')
          .first();

        if (conflict) {
          const err = new Error(
            `Position ${conflict.position} on ${DAY_NAMES[conflict.day_of_week]} is already taken`,
          );
          err.code = '23505';
          throw err;
        }
      }

      // No conflicts — atomically replace the driver's claims
      await t(TABLE).where({ driver_id: driverId }).delete();
      if (rows.length > 0) {
        try {
          await t(TABLE).insert(rows);
        } catch (insertErr) {
          if (insertErr.code === '23505') {
            // Race condition: another driver claimed the slot between the
            // pre-flight check and the insert.  Format and re-throw cleanly.
            const friendly = new Error(PositionClaim.formatConflict(insertErr));
            friendly.code = '23505';
            throw friendly;
          }
          throw insertErr;
        }
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
   * Check for conflicts without modifying anything.
   * Used by the pre-save check endpoint so the UI can surface errors immediately.
   *
   * @param {number} excludeDriverId — driver whose own claims should not count as conflicts
   * @param {object} dayPositionsObj — { "2": 10, "3": 200, … }
   * @returns {string|null}          — conflict message, or null if all slots are free
   */
  static async checkConflicts(excludeDriverId, dayPositionsObj) {
    const rows = Object.entries(dayPositionsObj)
      .filter(([, pos]) => pos !== null && pos !== undefined && Number(pos) > 0)
      .map(([day, pos]) => ({
        day_of_week: parseInt(day, 10),
        position:    parseInt(pos, 10),
      }));

    if (!rows.length) return null;

    const conflict = await db(TABLE)
      .where((q) => {
        rows.forEach((row) => {
          q.orWhere({ day_of_week: row.day_of_week, position: row.position });
        });
      })
      .whereNot({ driver_id: excludeDriverId })
      .select('day_of_week', 'position')
      .first();

    if (!conflict) return null;
    return `Position ${conflict.position} on ${DAY_NAMES[conflict.day_of_week]} is already taken`;
  }

  /** Returns all claims for a driver as { day_of_week, position } rows. */
  static getForDriver(driverId) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .select('day_of_week', 'position')
      .orderBy('day_of_week');
  }

  /**
   * Converts a PostgreSQL 23505 unique-violation error into a user-readable message.
   *
   * PG detail format: "Key (day_of_week, position)=(5, 200) already exists."
   *
   * @param  {Error}  err — the raw PG/Knex error
   * @returns {string}    — e.g. "Position 200 on Friday is already taken"
   */
  static formatConflict(err) {
    const detail = err.detail || '';
    const match  = detail.match(/\(day_of_week, position\)=\((\d+), (\d+)\)/);
    if (match) {
      const day      = parseInt(match[1], 10);
      const position = parseInt(match[2], 10);
      return `Position ${position} on ${DAY_NAMES[day]} is already taken`;
    }
    return 'One or more of your selected positions are already taken by another driver';
  }
}

module.exports = PositionClaim;
