/**
 * Add a unique constraint to drivers.vehicle_number.
 *
 * IMPORTANT: before deploying this migration, remove any duplicate
 * vehicle numbers from the database. The migration will fail if
 * duplicates exist.
 *
 * To find duplicates:
 *   SELECT vehicle_number, COUNT(*) FROM drivers GROUP BY vehicle_number HAVING COUNT(*) > 1;
 *
 * To deactivate the older duplicate (keep the one with the email):
 *   UPDATE drivers SET is_active = false WHERE id = <old_id>;
 */
exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.unique(['vehicle_number']);
  });
};

exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropUnique(['vehicle_number']);
  });
};
