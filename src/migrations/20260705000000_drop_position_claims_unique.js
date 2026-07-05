/**
 * Removes the UNIQUE(day_of_week, position) constraint from position_claims.
 *
 * Positions are no longer exclusive — any number of drivers may schedule the
 * same (day, position) slot, so drivers no longer get a "position is taken"
 * error when saving their schedule. The scheduler already fires each driver off
 * their own drivers.day_positions record and never consults position_claims for
 * ownership, so dropping the constraint has no effect on firing behaviour.
 *
 * Existing rows are left untouched — every driver keeps the schedule they
 * currently have. No backfill: the table already matches what each driver saved.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('position_claims', (table) => {
    table.dropUnique(['day_of_week', 'position']);
  });
};

exports.down = async function (knex) {
  // Re-adding the constraint can fail if shared slots now exist. Collapse
  // duplicates first, keeping the lowest driver_id per slot, then restore it.
  await knex.raw(`
    DELETE FROM position_claims a
    USING position_claims b
    WHERE a.day_of_week = b.day_of_week
      AND a.position    = b.position
      AND (a.driver_id > b.driver_id
           OR (a.driver_id = b.driver_id AND a.id > b.id))
  `);

  await knex.schema.alterTable('position_claims', (table) => {
    table.unique(['day_of_week', 'position']);
  });
};
