/**
 * insurance_policies — the fleet insurance policy the drivers/vehicles sit on.
 *
 * Seeded from the "UNITED TAXI WORKERS OF SAN DIEGO" monthly spreadsheet
 * (Incline Americas, policy #IA2026TLP00673, effective 2026-09-08). Kept as its
 * own table (rather than a single hard-coded constant) so a renewal is just a
 * new row: is_current flips to the active policy and the old one stays for
 * history. premium_per_vehicle is the annual per-vehicle premium ($4,056); the
 * monthly amortisation shown in the sheet is derived, never stored.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insurance_policies', (table) => {
    table.increments('id').primary();
    table.string('carrier').notNullable();
    table.string('policy_number').notNullable().unique();
    table.date('effective_date');
    table.date('expiration_date');
    table.decimal('premium_per_vehicle', 10, 2);
    table.text('notes');
    // Exactly one policy is the live one the module reports on by default.
    table.boolean('is_current').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insurance_policies');
};
