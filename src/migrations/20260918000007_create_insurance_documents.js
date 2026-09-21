/**
 * insurance_documents — uploaded insurance files (certificates, policy PDFs,
 * scans, etc.) shown on the Insurance → Documents tab.
 *
 * The bytes live on disk under data/insurance-uploads/ (the ./data volume is
 * mounted persistent AND gitignored, so private docs survive redeploys without
 * ever entering version control). Only metadata is stored here.
 *
 *   stored_name   the generated on-disk filename (random) — the ONLY value used
 *                 to build a filesystem path, so a malicious original_name can
 *                 never cause path traversal.
 *   original_name what the user uploaded / what download restores.
 *   uploaded_by   admins.id — plain integer, NO FK (admins table is seeded by a
 *                 script, not a migration; mirrors driver_audit_log/access_log).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insurance_documents', (table) => {
    table.increments('id').primary();
    table.integer('policy_id')
      .nullable()
      .references('id').inTable('insurance_policies')
      .onDelete('SET NULL');
    table.string('original_name').notNullable();
    table.string('stored_name').notNullable().unique();
    table.string('mime_type');
    table.bigInteger('size_bytes');
    table.text('description');
    table.integer('uploaded_by');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('policy_id');
    table.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insurance_documents');
};
