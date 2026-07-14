/**
 * driver_audit_log — one row per changed field on every driver-record edit.
 *
 * Motivation (2026-07-13 incident): a cab handover was applied as three manual
 * edits over two days (vehicle_number on record 35, then SAN credentials, then
 * blanking record 41). The drivers table keeps no history — updated_at is
 * overwritten by every edit — so reconstructing "what changed, when, and via
 * which interface" took a day of log/nginx archaeology. This table makes that
 * a single query.
 *
 *   driver_id     nullable + SET NULL so history survives a driver delete
 *   driver_name   denormalised for the same reason
 *   changed_by    'admin' | 'driver' — which interface performed the edit
 *   admin_id      admins.id when changed_by='admin'. Plain integer, NO foreign
 *                 key: the admins table is created by scripts/create-admin.js,
 *                 not a migration (an FK breaks fresh/test DBs), and an audit
 *                 row should keep the id even if the admin is deleted.
 *   field         drivers column name, e.g. 'vehicle_number'
 *   old_value /   stringified values; secrets (san_password, app_password) are
 *   new_value     stored as '(hidden)' / '(changed)' markers, never material
 */
exports.up = async function (knex) {
  await knex.schema.createTable('driver_audit_log', (table) => {
    table.increments('id').primary();
    table.integer('driver_id')
      .nullable()
      .references('id').inTable('drivers')
      .onDelete('SET NULL');
    table.string('driver_name').notNullable();
    table.string('changed_by', 10).notNullable();   // 'admin' | 'driver'
    table.integer('admin_id').nullable();
    table.string('field', 64).notNullable();
    table.text('old_value');
    table.text('new_value');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('driver_id');
    table.index('created_at');
    table.index('field');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('driver_audit_log');
};
