/**
 * Add a per-driver "add a card by this date" deadline.
 *
 * Targets the grandfathered / migrated cohort that has active access but no
 * payment method on Stripe (see scripts/backfill-card-required.js for how the
 * cohort is computed against Stripe truth — customer existence is NOT enough).
 *
 * Semantics:
 *   card_required_by = NULL          → not in the cohort (normal driver)
 *   card_required_by in the future   → in the 7-day grace window; dashboard shows
 *                                       a persistent "add your card" banner, full
 *                                       access is unchanged
 *   card_required_by in the past     → grace expired; the enforcement sweep
 *                                       (cardEnforcementService) deactivates them
 *                                       with subscription_status='past_due'
 *
 * Cleared (set back to NULL + is_active=true) by the Stripe webhook the moment a
 * card is confirmed on file. The column is left NULL here — it is populated only
 * by the one-time backfill script, never automatically, so the normal
 * card-upfront signup path is untouched.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.timestamp('card_required_by', { useTz: true }).nullable();
    // The enforcement sweep queries WHERE card_required_by < now repeatedly.
    table.index(['card_required_by'], 'idx_drivers_card_required_by');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('drivers', (table) => {
    table.dropIndex(['card_required_by'], 'idx_drivers_card_required_by');
    table.dropColumn('card_required_by');
  });
};
