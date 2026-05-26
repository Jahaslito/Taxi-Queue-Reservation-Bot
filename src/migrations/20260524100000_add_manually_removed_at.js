/**
 * Adds manually_removed_at to drivers.
 *
 * Set when a driver clicks the "Remove from Queue" button on the dashboard.
 * Used by the monitor to suppress auto-requeue for the rest of the day and
 * by admins to see who manually opted out.
 *
 * Reset at midnight Pacific (cleared on a daily reset) so the next day
 * starts fresh.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.timestamp('manually_removed_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.dropColumn('manually_removed_at');
  });
};
