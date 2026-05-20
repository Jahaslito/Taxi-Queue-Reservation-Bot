/**
 * Adds scheduled_position to drivers.
 * When set, the monitor triggers the bot when the live queue waiting count
 * reaches (scheduled_position - 3), placing the driver at approximately
 * their target position. Mutually exclusive with scheduled_time — the UI
 * enforces one-at-a-time.
 */
exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.integer('scheduled_position').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropColumn('scheduled_position');
  });
};
