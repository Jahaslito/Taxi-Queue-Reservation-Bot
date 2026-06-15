const db = require('../config/database');

const MESSAGES   = 'driver_messages';
const RECIPIENTS = 'driver_message_recipients';

/**
 * Per-driver delivery + read state for broadcast messages. Powers the driver
 * app's inbox, unread badge, and mark-as-read actions. Every query is scoped to
 * a single driver_id so a driver can only ever see / mutate their own rows.
 */
class DriverMessageRecipient {
  /** A driver's inbox — message content joined with their read state, newest first. */
  static listForDriver(driverId, { limit = 30, offset = 0 } = {}) {
    return db({ r: RECIPIENTS })
      .join({ m: MESSAGES }, 'm.id', 'r.message_id')
      .where('r.driver_id', driverId)
      .select(
        'r.message_id as id',
        'r.read_at',
        'm.title',
        'm.body',
        'm.url',
        'm.created_at',
      )
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static async unreadCount(driverId) {
    const row = await db(RECIPIENTS)
      .where({ driver_id: driverId })
      .whereNull('read_at')
      .count('* as count')
      .first();
    return parseInt(row.count, 10) || 0;
  }

  /**
   * Mark one message read for this driver. Scoped to driver_id so it can't touch
   * another driver's row. Idempotent — re-marking a read message is a no-op.
   * @returns {Promise<boolean>} true if a row transitioned unread → read
   */
  static async markRead(driverId, messageId) {
    const updated = await db(RECIPIENTS)
      .where({ driver_id: driverId, message_id: messageId })
      .whereNull('read_at')
      .update({ read_at: db.fn.now() });
    return updated > 0;
  }

  static markAllRead(driverId) {
    return db(RECIPIENTS)
      .where({ driver_id: driverId })
      .whereNull('read_at')
      .update({ read_at: db.fn.now() });
  }
}

module.exports = DriverMessageRecipient;
