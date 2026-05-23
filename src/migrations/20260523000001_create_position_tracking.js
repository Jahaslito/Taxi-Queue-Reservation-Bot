/**
 * Position accuracy tracking.
 *
 * One row is inserted each time the position-schedule bot fires.
 * actual_position and landed_at are filled in when the driver first
 * appears in the V Holding queue on a subsequent poll tick.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('position_tracking', (table) => {
    table.increments('id');
    table.integer('driver_id').notNullable().references('id').inTable('drivers').onDelete('CASCADE');
    table.string('vehicle_number', 20).notNullable();
    table.integer('target_position').notNullable();
    table.integer('queue_size_at_fire');   // how many were waiting when bot fired
    table.decimal('growth_rate', 8, 2);   // effectiveGrowthRate at fire time
    table.integer('estimated_drift');      // drift the formula calculated
    table.integer('actual_position');      // where they actually landed (filled later)
    table.timestamp('fired_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('landed_at');        // when they appeared in queue
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('position_tracking');
};
