/**
 * Adds Stripe subscription tracking columns to the drivers table.
 * Grandfathers all existing drivers so they aren't locked out on deploy.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.string('stripe_customer_id',     64).nullable();
    table.string('stripe_subscription_id', 64).nullable();
    // trialing | active | past_due | canceled | unpaid | incomplete
    table.string('subscription_status',    32).nullable();
    table.timestamp('trial_ends_at', { useTz: true }).nullable();
  });

  // ── Grandfather all existing drivers ────────────────────────────────────────
  // 1. Mark every existing driver as having an active subscription so they
  //    aren't suddenly locked out when this migration runs.
  await knex('drivers').update({ subscription_status: 'active' });

  // 2. If a driver never verified their email (they were using the system before
  //    email verification was enforced), mark them as verified so they aren't
  //    blocked by the new email gate.
  await knex('drivers')
    .whereNull('email_verified_at')
    .update({ email_verified_at: knex.fn.now() });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropColumn('stripe_customer_id');
    table.dropColumn('stripe_subscription_id');
    table.dropColumn('subscription_status');
    table.dropColumn('trial_ends_at');
  });
};
