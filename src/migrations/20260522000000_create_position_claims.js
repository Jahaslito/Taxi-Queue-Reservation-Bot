/**
 * Creates the position_claims table for exclusive (day_of_week, position) slot ownership.
 *
 * The UNIQUE constraint on (day_of_week, position) is the enforcement mechanism —
 * the DB rejects any duplicate slot at insert time (error code 23505).  Application
 * code catches that and returns a 409 with a human-readable message.
 *
 * Also migrates legacy scheduled_position (global, no day context) into day_positions
 * so the old field can be fully retired.  Existing day_positions rows are then
 * back-filled into position_claims; ON CONFLICT DO NOTHING handles the unlikely case
 * where two drivers previously shared the same global position.
 */
exports.up = async function (knex) {
  // ── 1. Create position_claims ────────────────────────────────────────────────
  await knex.schema.createTable('position_claims', (table) => {
    table.increments('id').primary();
    table.integer('driver_id')
      .notNullable()
      .references('id').inTable('drivers')
      .onDelete('CASCADE');        // auto-clears when driver is deleted
    table.smallint('day_of_week').notNullable().checkBetween([0, 6]); // 0=Sun … 6=Sat
    table.integer('position').notNullable().checkPositive();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.unique(['day_of_week', 'position']); // THE enforcement constraint
    table.index('driver_id');                  // fast deletes on driver update
  });

  // ── 2. Migrate scheduled_position → day_positions ───────────────────────────
  // Expand each global position to all 7 days so the monitor's existing
  // day_positions logic handles them identically.
  const toMigrate = await knex('drivers')
    .whereNotNull('scheduled_position')
    .whereNull('day_positions')
    .select('id', 'scheduled_position');

  for (const driver of toMigrate) {
    const dp = {};
    for (let d = 0; d < 7; d++) dp[String(d)] = driver.scheduled_position;
    await knex('drivers')
      .where({ id: driver.id })
      .update({ day_positions: JSON.stringify(dp), scheduled_position: null });
  }

  // Defensive: clear any remaining scheduled_position (shouldn't exist but belt-and-braces)
  await knex('drivers').whereNotNull('scheduled_position').update({ scheduled_position: null });

  // ── 3. Back-fill position_claims from all existing day_positions rows ─────────
  const allWithPositions = await knex('drivers')
    .whereNotNull('day_positions')
    .select('id', 'day_positions');

  for (const driver of allWithPositions) {
    let dp;
    try { dp = JSON.parse(driver.day_positions); } catch { continue; }

    const rows = Object.entries(dp)
      .filter(([, pos]) => pos !== null && pos !== undefined && Number(pos) > 0)
      .map(([day, pos]) => ({
        driver_id:   driver.id,
        day_of_week: parseInt(day, 10),
        position:    parseInt(pos, 10),
      }));

    if (!rows.length) continue;

    // ON CONFLICT DO NOTHING: first driver (lowest id) wins the slot.
    // The second driver's day_positions is preserved but they have no claim —
    // they will be prompted to choose a new position on their next save.
    await knex('position_claims')
      .insert(rows)
      .onConflict(['day_of_week', 'position'])
      .ignore();
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('position_claims');
  // scheduled_position values are NOT restored — they now live in day_positions.
};
