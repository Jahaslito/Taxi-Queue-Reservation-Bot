/**
 * Per-terminal dwell & requeue-latency metrics.
 *
 * One row is written each time a dispatched driver is auto-requeued after a
 * terminal trip (T1 or T2). Lets the admin diagnostics answer "is T1 slower to
 * requeue than T2?" with data instead of anecdote.
 *
 * Columns:
 *   terminal              'T1' | 'T2' | null (null when never seen on a page)
 *   requeue_path          how the requeue was triggered:
 *                           'left_terminal'    — seen on a terminal, then gone (prompt)
 *                           'timeout'          — never seen on a terminal, requeued after N checks
 *                           'san_auto_returned'— SAN put them back in V Holding before we polled
 *   dwell_seconds         at_terminal_since → requeued_at (total time out of the queue)
 *   detection_lag_seconds last terminal sighting → requeued_at (our responsiveness); null if never seen
 *   terminal_position     last known position in the terminal line (null if never seen)
 *
 * vehicle_number is denormalised so history survives a driver delete; driver_id
 * is nullable and SET NULL on delete for the same reason.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('terminal_metrics', (table) => {
    table.increments('id').primary();
    table.integer('driver_id')
      .nullable()
      .references('id').inTable('drivers')
      .onDelete('SET NULL');
    table.string('vehicle_number').notNullable();
    table.string('terminal', 4);                 // 'T1' | 'T2' | null
    table.string('requeue_path', 24).notNullable();
    table.timestamp('at_terminal_since');
    table.timestamp('terminal_last_seen_at');
    table.timestamp('requeued_at').notNullable().defaultTo(knex.fn.now());
    table.integer('dwell_seconds');
    table.integer('detection_lag_seconds');
    table.integer('terminal_position');
    table.date('tracking_date').notNullable();   // PT day, for grouping/filtering
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index('tracking_date');
    table.index('terminal');
    table.index('requeued_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('terminal_metrics');
};
