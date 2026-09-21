/**
 * Role-based access control for admin accounts.
 *
 * Adds a `role` to admin_users:
 *   'super_admin' — full admin panel (the default; every existing admin keeps it).
 *   'insurance'   — the insurance portal only (enforced in middleware/auth.js).
 *
 * Defaulting existing rows to 'super_admin' preserves current access. Guarded
 * with hasColumn so re-running (or a DB where the column already exists) is safe.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('admin_users', 'role');
  if (!has) {
    await knex.schema.alterTable('admin_users', (table) => {
      table.string('role', 32).notNullable().defaultTo('super_admin');
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('admin_users', 'role');
  if (has) {
    await knex.schema.alterTable('admin_users', (table) => {
      table.dropColumn('role');
    });
  }
};
