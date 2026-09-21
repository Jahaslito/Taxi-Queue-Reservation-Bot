const db = require('../config/database');

const TABLE = 'insurance_access_log';

class InsuranceAccessLog {
  /**
   * Record a PII access (currently DL reveals). Never throws — an audit-write
   * failure must not break the reveal it is recording (same posture as
   * DriverAudit). Returns true on success, false if the write failed.
   */
  static async record({ adminId, action, entity, entityId, detail, ip }) {
    try {
      await db(TABLE).insert({
        admin_id:  adminId ?? null,
        action,
        entity,
        entity_id: entityId ?? null,
        detail:    detail ?? null,
        ip:        ip ? String(ip).slice(0, 64) : null,
      });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = InsuranceAccessLog;
