/**
 * insured_drivers — the driver roster on the policy (spreadsheet tab
 * "UTWSD DRIVERS", ~325 rows across ~219 operating companies).
 *
 * This is a broader population than the app's `drivers` table (paying SanQueue
 * subscribers): most insured drivers are not app users. It is kept separate so
 * the bot/scheduler is untouched and the sensitive PII here (dl_number, dob,
 * address) stays isolated behind the admin-only insurance endpoints — dl_number
 * is never returned in list payloads (masked), only via the audited reveal.
 *
 *   needs_medical        derived from the "Needs Medical" note (9 rows).
 *   no_driver_assigned   the 14 vehicles whose driver slot reads "NO DRIVER
 *                        ASSIGNED" in the sheet.
 *   driver_id            link to drivers.id via cab_number → vehicle_number.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insured_drivers', (table) => {
    table.increments('id').primary();
    table.integer('policy_id')
      .nullable()
      .references('id').inTable('insurance_policies')
      .onDelete('SET NULL');
    table.string('cab_number');
    table.string('company');
    table.text('address');
    table.string('first_name');
    table.string('last_name');
    table.string('dl_number');          // PII — masked in list responses
    table.date('dob');                  // PII — implausible values imported as null
    table.boolean('needs_medical').notNullable().defaultTo(false);
    table.boolean('no_driver_assigned').notNullable().defaultTo(false);
    table.text('notes');
    table.integer('driver_id')
      .nullable()
      .references('id').inTable('drivers')
      .onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('cab_number');
    table.index('driver_id');
    table.index('company');
    table.index('last_name');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insured_drivers');
};
