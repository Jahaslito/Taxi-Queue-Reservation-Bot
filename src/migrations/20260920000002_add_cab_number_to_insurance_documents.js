/**
 * Every uploaded insurance document must be tagged with the cab (vehicle) number
 * it belongs to. Nullable at the DB level so pre-existing rows (uploaded before
 * this rule) remain valid; the API enforces it as mandatory for all NEW uploads
 * (see controllers/insuranceController.js uploadDocuments).
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('insurance_documents', 'cab_number');
  if (!has) {
    await knex.schema.alterTable('insurance_documents', (table) => {
      table.string('cab_number', 32);
      table.index('cab_number');
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('insurance_documents', 'cab_number');
  if (has) {
    await knex.schema.alterTable('insurance_documents', (table) => {
      table.dropColumn('cab_number');
    });
  }
};
