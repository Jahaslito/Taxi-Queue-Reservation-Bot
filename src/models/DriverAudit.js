const db = require('../config/database');

const TABLE = 'driver_audit_log';

// Secrets: record THAT they changed, never the material. app_password is a
// bcrypt hash and san_password is AES ciphertext in both `before` and `after`,
// but even hashes/ciphertext don't belong in an audit trail.
const MASKED_FIELDS = new Set(['san_password', 'app_password']);

/** Stringify a column value for the text old/new columns. */
function asText(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

class DriverAudit {
  /**
   * Diff `before` (current DB row) against `after` (the update payload) and
   * insert one row per changed field. Only keys present in `after` are
   * compared — both controllers build a full-row payload, so this covers
   * every editable column without hardcoding a list.
   *
   * BEST-EFFORT: never throws. The edit itself must not fail (or roll back)
   * because auditing hiccuped — callers invoke this after the update commits.
   */
  static async recordChanges({ driverId, driverName, changedBy, adminId = null, before, after }) {
    try {
      const rows = [];
      for (const [field, afterVal] of Object.entries(after)) {
        const oldText = asText(before[field]);
        const newText = asText(afterVal);
        if (oldText === newText) continue;

        const masked = MASKED_FIELDS.has(field);
        rows.push({
          driver_id:   driverId,
          driver_name: driverName,
          changed_by:  changedBy,
          admin_id:    adminId,
          field,
          old_value:   masked ? (oldText === null ? null : '(hidden)') : oldText,
          new_value:   masked ? '(changed)' : newText,
        });
      }
      if (rows.length) await db(TABLE).insert(rows);
      return rows.length;
    } catch (err) {
      console.warn(`[Audit] Failed to record driver changes (driver ${driverId}):`, err.message);
      return 0;
    }
  }

  /** Change history for one driver, newest first. */
  static forDriver(driverId, { limit = 100 } = {}) {
    return db(TABLE)
      .where({ driver_id: driverId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }
}

module.exports = DriverAudit;
