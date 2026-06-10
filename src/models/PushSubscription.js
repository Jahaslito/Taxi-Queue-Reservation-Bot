const db = require('../config/database');

const TABLE = 'push_subscriptions';

class PushSubscription {
  /**
   * Insert or refresh a browser's push endpoint. Keyed on `endpoint` because
   * that's what's unique to each browser+device; same admin on two devices
   * gets two rows, which is what we want.
   */
  static async upsert({ role, subscriberId, endpoint, p256dhKey, authKey }) {
    const row = {
      role,
      subscriber_id: subscriberId ?? null,
      endpoint,
      p256dh_key:    p256dhKey,
      auth_key:      authKey,
    };

    const [saved] = await db(TABLE)
      .insert(row)
      .onConflict('endpoint')
      .merge({
        role,
        subscriber_id: subscriberId ?? null,
        p256dh_key:    p256dhKey,
        auth_key:      authKey,
      })
      .returning(['id', 'endpoint']);

    return saved;
  }

  static findAllByRole(role) {
    return db(TABLE).where({ role });
  }

  static deleteByEndpoint(endpoint) {
    return db(TABLE).where({ endpoint }).del();
  }

  static touch(endpoint) {
    return db(TABLE).where({ endpoint }).update({ last_used_at: db.fn.now() });
  }
}

module.exports = PushSubscription;
