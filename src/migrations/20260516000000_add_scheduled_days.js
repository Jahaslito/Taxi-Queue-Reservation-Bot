exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.string('scheduled_days').notNullable().defaultTo('0,1,2,3,4,5,6');
  });
};

exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropColumn('scheduled_days');
  });
};
