const db = require('../config/database');

const TABLE = 'admin_users';

// Access-control roles. 'super_admin' = full admin panel; 'insurance' = the
// insurance portal only (see middleware/auth.js restrictInsuranceRole).
const ROLES = ['super_admin', 'insurance'];

class Admin {
  static findByUsername(username) {
    return db(TABLE).where({ username }).first();
  }

  static findById(id) {
    return db(TABLE).select(['id', 'username', 'role', 'created_at']).where({ id }).first();
  }

  static async create(data) {
    const [admin] = await db(TABLE).insert(data).returning(['id', 'username', 'role']);
    return admin;
  }

  /** Change an admin's role. Returns rows updated (0 if the username is unknown). */
  static setRole(username, role) {
    return db(TABLE)
      .where({ username })
      .update({ role, updated_at: db.fn.now() });
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

Admin.ROLES = ROLES;

module.exports = Admin;
