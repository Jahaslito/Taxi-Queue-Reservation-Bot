/**
 * Expands position_tracking so it records every position-scheduler decision,
 * not only successful fires. After this migration there is exactly one row per
 * (driver, day) — upserted as the driver's state evolves through the day.
 *
 * New columns:
 *   tracking_date           — date in PT, paired with driver_id for the unique key
 *   decision                — one of: waiting, fired, completed, failed,
 *                             skip_already_seen, skip_bot_inflight,
 *                             missed_impossible
 *   decision_reason         — short human-readable explanation
 *   max_acceptable_position — snapshot of the driver's tolerance at decision time
 *   predicted_landing       — projected landing at decision time
 *   bot_duration_ms         — actual bot execution time (filled when bot completes)
 *
 * Schema changes:
 *   fired_at is now nullable — skip/wait rows don't have a fire event
 *   unique (driver_id, tracking_date) for ON CONFLICT upserts
 *
 * Backfill:
 *   Existing rows get tracking_date derived from fired_at (PT) and
 *   decision = 'completed' (since the old code only inserted on successful fires).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('position_tracking', (table) => {
    table.date('tracking_date');
    table.string('decision', 32);
    table.text('decision_reason');
    table.integer('max_acceptable_position');
    table.integer('predicted_landing');
    table.integer('bot_duration_ms');
  });

  // fired_at was NOT NULL with a default of now() — drop the constraint so
  // skip/wait rows can store NULL when no fire ever happened.
  await knex.raw('ALTER TABLE position_tracking ALTER COLUMN fired_at DROP NOT NULL');

  // Backfill tracking_date and decision for legacy rows.
  // The old code only inserted on fire, so any existing row is a completed fire.
  await knex.raw(`
    UPDATE position_tracking
    SET tracking_date = (fired_at AT TIME ZONE 'America/Los_Angeles')::date,
        decision      = CASE WHEN actual_position IS NOT NULL THEN 'completed' ELSE 'fired' END,
        decision_reason = 'backfilled_from_legacy_row'
    WHERE tracking_date IS NULL
  `);

  // Make tracking_date NOT NULL now that backfill is complete — required for
  // a non-partial unique index, which is what ON CONFLICT needs to match.
  await knex.raw('ALTER TABLE position_tracking ALTER COLUMN tracking_date SET NOT NULL');

  // Plain unique index so .onConflict(['driver_id', 'tracking_date']) can target it.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS position_tracking_driver_date_idx
    ON position_tracking (driver_id, tracking_date)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS position_tracking_driver_date_idx');
  await knex.schema.alterTable('position_tracking', (table) => {
    table.dropColumn('tracking_date');
    table.dropColumn('decision');
    table.dropColumn('decision_reason');
    table.dropColumn('max_acceptable_position');
    table.dropColumn('predicted_landing');
    table.dropColumn('bot_duration_ms');
  });
};
