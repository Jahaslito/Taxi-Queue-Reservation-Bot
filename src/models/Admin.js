const db = require('../config/database');

const TABLE = 'admin_users';

class Admin {
  static findByUsername(username) {
    return db(TABLE).where({ username }).first();
  }

  static findById(id) {
    return db(TABLE).select(['id', 'username', 'created_at']).where({ id }).first();
  }

  static async create(data) {
    const [admin] = await db(TABLE).insert(data).returning(['id', 'username']);
    return admin;
  }

  /** Returns truthy if at least one admin account exists */
  static exists() {
    return db(TABLE).select('id').first();
  }

  /**
   * Overwrite an existing admin's password hash.
   * Returns the number of rows updated (0 if the username doesn't exist).
   */
  static updatePassword(username, password_hash) {
    return db(TABLE)
      .where({ username })
      .update({ password_hash, updated_at: db.fn.now() });
  }
}

module.exports = Admin;
