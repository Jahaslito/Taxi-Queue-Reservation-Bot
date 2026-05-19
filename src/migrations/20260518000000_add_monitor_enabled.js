/**
 * Adds monitor_enabled flag to drivers.
 * When true, the queue monitor watches this driver and auto-requeues
 * them when they leave the V Holding queue.
 */
exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.boolean('monitor_enabled').notNullable().defaultTo(false);
  });
  await knex.schema.table('drivers', (table) => {
    table.index('monitor_enabled', 'idx_drivers_monitor_enabled');
  });
};

exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropIndex('monitor_enabled', 'idx_drivers_monitor_enabled');
    table.dropColumn('monitor_enabled');
  });
};
