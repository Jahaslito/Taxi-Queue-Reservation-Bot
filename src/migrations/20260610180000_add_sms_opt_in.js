/**
 * Add per-driver SMS opt-in flag.
 *
 * Required by Telnyx toll-free verification — the registration page must
 * present SMS opt-in as a separate, OPTIONAL checkbox (not bundled into the
 * general "by signing up you agree" disclosure), and the system must respect
 * the choice when dispatching messages.
 *
 * New rows default to false (no SMS unless the driver explicitly opts in at
 * signup). Existing rows are grandfathered to true — those drivers signed up
 * under the previous consent block which contained an SMS disclosure as part
 * of the implicit agreement, so we honor that prior consent rather than
 * silently turning their alerts off.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.boolean('sms_opt_in').notNullable().defaultTo(false);
  });
  // Grandfather existing drivers — they signed up under the prior consent
  // text that bundled SMS disclosure into the create-account agreement.
  await knex('drivers').update({ sms_opt_in: true });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.dropColumn('sms_opt_in');
  });
};
