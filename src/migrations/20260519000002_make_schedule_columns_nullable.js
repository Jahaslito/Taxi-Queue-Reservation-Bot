exports.up = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.string('scheduled_days').nullable().alter();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('drivers', table => {
    table.string('scheduled_days').notNullable().defaultTo('0,1,2,3,4,5,6').alter();
  });
};
