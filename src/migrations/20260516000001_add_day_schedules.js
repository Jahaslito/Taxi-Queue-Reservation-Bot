exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.text('day_schedules').nullable();
  });
};
exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropColumn('day_schedules');
  });
};
