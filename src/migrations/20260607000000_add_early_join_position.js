'use strict';

/**
 * Adds `early_join_position` to position_tracking.
 *
 * Populated when a position-scheduled driver is detected in V Holding at a
 * queue position significantly lower than their target (i.e. they joined the
 * SAN queue manually before the burst window instead of waiting for the
 * position bot). Knowing the actual join position lets the admin table show
 * the magnitude of the early join and investigate patterns over time.
 *
 * Nullable: null for normal fired/waiting/missed rows; an integer queue
 * position (e.g. 2) for skip_already_seen rows where early-join was detected.
 */
exports.up = async (knex) => {
  await knex.schema.table('position_tracking', (t) => {
    t.integer('early_join_position').nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.table('position_tracking', (t) => {
    t.dropColumn('early_join_position');
  });
};
