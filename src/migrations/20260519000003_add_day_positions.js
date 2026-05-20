exports.up = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.text('day_positions').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.dropColumn('day_positions');
  });
};
