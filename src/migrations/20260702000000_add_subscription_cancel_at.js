/**
 * Add the scheduled-cancellation date for a driver's subscription.
 *
 * Stripe's billing portal cancels "at period end" by default: the moment a
 * driver clicks cancel, Stripe schedules the cancellation and emits
 * customer.subscription.updated with cancel_at_period_end=true and cancel_at
 * set to the period-end timestamp. The subscription STAYS active/trialing (and
 * the driver keeps full access) until that date, when
 * customer.subscription.deleted fires and status flips to canceled.
 *
 * Semantics:
 *   subscription_cancel_at = NULL        → no cancellation scheduled (normal)
 *   subscription_cancel_at in the future → cancellation pending; the dashboard
 *                                          shows a persistent "access ends on
 *                                          <date>" banner, access is unchanged
 *
 * Set by the Stripe webhook on customer.subscription.updated when
 * cancel_at_period_end is true. Cleared (→ NULL) when the schedule is removed
 * (driver resubscribes / un-cancels) or when the subscription is finally
 * deleted / reactivated.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.timestamp('subscription_cancel_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.dropColumn('subscription_cancel_at');
  });
};
