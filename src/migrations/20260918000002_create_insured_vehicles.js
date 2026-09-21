/**
 * insured_vehicles — one row per vehicle on the policy (spreadsheet tab
 * "UTWSD VEHICLES").
 *
 *   vin          the real identity of a vehicle and the upsert key — 298 rows,
 *                298 distinct VINs.
 *   cab_number   the operator-facing label, indexed but deliberately NOT unique:
 *                cab #s 105/747/2026 each appear on two different vehicles (an
 *                old cab going off-policy and a new one reusing the number), so
 *                a unique constraint would reject the real data.
 *   driver_id    resolved at import time by matching cab_number →
 *                drivers.vehicle_number (which IS unique). Nullable + SET NULL so
 *                the roster survives an app-driver delete and covers the ~15
 *                vehicles with no assigned app driver.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insured_vehicles', (table) => {
    table.increments('id').primary();
    table.integer('policy_id')
      .nullable()
      .references('id').inTable('insurance_policies')
      .onDelete('SET NULL');
    table.string('vin').notNullable().unique();
    table.string('cab_number');
    table.string('company');
    table.integer('year');
    table.string('make');
    table.string('model');
    table.date('on_policy_date');
    table.date('off_policy_date');
    table.decimal('premium', 10, 2);
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
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insured_vehicles');
};
