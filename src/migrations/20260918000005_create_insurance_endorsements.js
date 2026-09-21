/**
 * insurance_endorsements — the "Endorsements Starter" tab (~249 rows): the
 * pending/added endorsement list keyed by cab #. Same PII posture as
 * insured_drivers (dl_number masked in list responses). `added` marks whether
 * the endorsement has been applied vs is still staged (several rows carry XXXX
 * placeholders for cab #/address in the sheet, imported as null).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('insurance_endorsements', (table) => {
    table.increments('id').primary();
    table.integer('policy_id')
      .nullable()
      .references('id').inTable('insurance_policies')
      .onDelete('SET NULL');
    table.string('cab_number');
    table.string('company');
    table.text('address');
    table.string('first_name');
    table.string('last_name');
    table.string('dl_number');          // PII — masked in list responses
    table.date('dob');
    table.text('endorsement_text');
    table.boolean('added').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('cab_number');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('insurance_endorsements');
};
