const db = require('../config/database');

const MESSAGES   = 'driver_messages';
const RECIPIENTS = 'driver_message_recipients';

/**
 * Admin-authored broadcast messages and their delivery stats. Recipient rows
 * (per-driver read state) live in the DriverMessageRecipient model — this model
 * owns the message record itself plus the admin-facing "sent history".
 */
class DriverMessage {
  /**
   * Create a message and its recipient rows atomically. Persisting recipients
   * up-front means the driver inbox is correct even if push/SMS fan-out later
   * fails — delivery is best-effort, but the in-app record is the source of truth.
   *
   * @param {object} args
   * @param {number|null} args.adminId
   * @param {string}      args.title
   * @param {string}      args.body
   * @param {string|null} args.url
   * @param {'all'|'selected'} args.targetType
   * @param {boolean}     args.sendSms
   * @param {number[]}    args.driverIds   resolved recipient driver ids
   * @returns {Promise<object>} the created message row
   */
  static async createWithRecipients({ adminId, title, body, url, targetType, sendSms, driverIds }) {
    return db.transaction(async (trx) => {
      const [message] = await trx(MESSAGES)
        .insert({
          admin_id:    adminId ?? null,
          title,
          body,
          url:         url || null,
          target_type: targetType,
          send_sms:    !!sendSms,
        })
        .returning('*');

      if (driverIds.length) {
        const rows = driverIds.map((driverId) => ({
          message_id: message.id,
          driver_id:  driverId,
        }));
        // Chunked insert keeps a large blast (hundreds of drivers) under the
        // Postgres parameter limit and scales without a giant single statement.
        await trx.batchInsert(RECIPIENTS, rows, 500);
      }

      return message;
    });
  }

  /** Write delivery counters back onto the message after fan-out completes. */
  static async updateDeliveryStats(id, stats) {
    const [row] = await db(MESSAGES).where({ id }).update(stats).returning('*');
    return row;
  }

  /**
   * Admin "sent history", newest first. Each row carries correlated recipient
   * and read counts so the dashboard can show reach + engagement without a
   * separate round-trip.
   */
  static listRecent({ limit = 25, offset = 0 } = {}) {
    return db({ m: MESSAGES })
      .select('m.*')
      .select({
        recipient_count: db(RECIPIENTS).count('*').whereRaw('message_id = m.id'),
        read_count:      db(RECIPIENTS).count('*').whereRaw('message_id = m.id and read_at is not null'),
      })
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static countAll() {
    return db(MESSAGES).count('* as count').first();
  }
}

module.exports = DriverMessage;
