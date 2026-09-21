/**
 * insurance_claims — accident / loss history parsed out of the "ACCIDENTS"
 * column on the drivers tab (19 rows carry text like
 * "Claim #AGMKN26040001 - DOL 03/16/2026").
 *
 * claim_number and date_of_loss are best-effort extracted by the importer; the
 * untouched cell is kept in `raw` so nothing is lost when the free-text format
 * varies. insured_driver_id CASCADEs — a full-sheet re-import wipes and rebuilds
 * insured_drivers, and the derived claims should go with them.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insurance_claims', (table) => {
    table.increments('id').primary();
    table.integer('insured_driver_id')
      .nullable()
      .references('id').inTable('insured_drivers')
      .onDelete('CASCADE');
    table.string('cab_number');
    table.string('claim_number');
    table.date('date_of_loss');
    table.text('description');
    table.text('raw');                  // original spreadsheet cell, verbatim
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('cab_number');
    table.index('insured_driver_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insurance_claims');
};
