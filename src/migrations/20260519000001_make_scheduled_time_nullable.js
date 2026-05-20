exports.up = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.string('scheduled_time', 5).nullable().alter();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.string('scheduled_time', 5).notNullable().defaultTo('05:00').alter();
  });
};
