/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable('drivers', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.string('phone');
    table.string('email').unique();
    table.string('app_password').notNullable();
    table.string('san_username').notNullable();
    table.text('san_password').notNullable();   // AES-256-CBC encrypted
    table.string('vehicle_number').notNullable();
    table.string('scheduled_time', 5).notNullable().defaultTo('05:00'); // HH:MM Pacific Time
    table.boolean('is_active').notNullable().defaultTo(true);
    table.text('notes');
    table.timestamps(true, true); // created_at, updated_at — auto-managed by PostgreSQL
  });

  await knex.schema.createTable('logs', (table) => {
    table.increments('id').primary();
    table.integer('driver_id').notNullable()
      .references('id').inTable('drivers').onDelete('CASCADE');
    table.timestamp('triggered_at', { useTz: true }).notNullable();
    table.string('trigger_type', 20).notNullable().defaultTo('scheduled');
    table.string('status', 20).notNullable().defaultTo('pending');
    table.integer('queue_position');
    table.string('queue_location');
    table.string('queue_time', 10);
    table.text('error_message');
    table.integer('duration_ms');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('admin_users', (table) => {
    table.increments('id').primary();
    table.string('username').unique().notNullable();
    table.string('password_hash').notNullable();
    table.timestamps(true, true);
  });

  // Indexes for the most common query patterns
  await knex.schema.table('logs', (table) => {
    table.index('driver_id',    'idx_logs_driver_id');
    table.index('triggered_at', 'idx_logs_triggered_at');
    table.index('status',       'idx_logs_status');
  });

  await knex.schema.table('drivers', (table) => {
    table.index(['is_active', 'scheduled_time'], 'idx_drivers_active_scheduled');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('logs');
  await knex.schema.dropTableIfExists('drivers');
  await knex.schema.dropTableIfExists('admin_users');
};
