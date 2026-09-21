/**
 * insurance_access_log — audit trail for access to insurance PII.
 *
 * The insurance roster holds driver's-license numbers and dates of birth. List
 * views only ever show a masked DL (e.g. ••••5385); the full value is served
 * only by the explicit reveal endpoint, and every reveal writes a row here so
 * "who looked at whose DL, and when" is a single query. Mirrors the
 * driver_audit_log design: admin_id is a plain integer with NO foreign key —
 * the admins table is created by scripts/create-admin.js, not a migration, so
 * an FK would break fresh/test DBs, and the log should keep the id even if the
 * admin is later removed.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insurance_access_log', (table) => {
    table.increments('id').primary();
    table.integer('admin_id');                       // no FK — see note above
    table.string('action', 32).notNullable();        // e.g. 'reveal_dl'
    table.string('entity', 32).notNullable();         // 'insured_driver' | 'endorsement'
    table.integer('entity_id');
    table.string('detail');                           // e.g. which field was revealed
    table.string('ip', 64);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('created_at');
    table.index(['entity', 'entity_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insurance_access_log');
};
