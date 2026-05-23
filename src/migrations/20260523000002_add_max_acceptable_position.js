/**
 * Adds max_acceptable_position to drivers.
 *
 * The position scheduler skips firing when the queue is already past this value,
 * preventing scenarios like #0920 (target 60, landed 171). When NULL, the
 * application defaults to target + 20 so existing drivers get sensible behaviour
 * with no migration of data rows required.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.integer('max_acceptable_position').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.dropColumn('max_acceptable_position');
  });
};
