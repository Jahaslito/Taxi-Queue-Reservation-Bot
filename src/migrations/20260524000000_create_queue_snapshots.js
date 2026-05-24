/**
 * queue_snapshots — one row per poll tick, captures the V-Holding state plus
 * all the rate/prediction signals our scheduler used at that moment.
 *
 * Purpose: build a time-series dataset rich enough to find position-dependent
 * growth bursts (e.g. "queue grows by 30 around position 110-130 on Saturday
 * 5:30 AM"). The scheduler's current constant-rate drift model can't capture
 * these — but with this data we can eventually learn them and switch to a
 * position-aware drift function.
 *
 * Sizing:
 *   • ~3-4k rows/day at our adaptive poll cadence (30s idle / 10s near fire
 *     / 5s at fire)
 *   • ~110 MB/year — trivial for Postgres
 *
 * Indexes:
 *   • (day_of_week, hour_pt) — the natural lookup pattern for "growth rate
 *     at this position on this kind of day"
 *   • (observed_at DESC) — for recent time-series queries
 */
exports.up = async function (knex) {
  await knex.schema.createTable('queue_snapshots', (table) => {
    table.bigIncrements('id');
    table.timestamp('observed_at').notNullable().defaultTo(knex.fn.now());

    // Raw queue state from parsed V-Holding page
    table.integer('waiting_count').notNullable();
    table.integer('dispatched_count').notNullable();
    table.integer('not_authorized_count').notNullable().defaultTo(0);

    // The three growth-rate signals our scheduler combines via max()
    table.decimal('last_poll_rate',       8, 3); // drivers/sec since previous poll
    table.decimal('short_window_rate',    8, 3); // slope over last 3 polls
    table.decimal('smoothed_growth_rate', 8, 3); // EMA α=0.7
    table.decimal('effective_growth_rate',8, 3); // max() of the four — what was actually used

    // Prediction-model state — useful for back-testing "what would the model
    // have predicted at this moment?"
    table.integer('bot_p95_ms');                 // current rolling P95 of bot durations
    table.integer('bot_latency_samples');        // how many samples in the buffer
    table.decimal('bias_correction',      6, 2); // current median(actual - target)
    table.integer('poll_interval_ms');           // adaptive cadence at this tick

    // Time slicing for analysis — denormalised so queries don't need timezone
    // conversion on every row.  All in Pacific Time.
    table.smallint('day_of_week').notNullable(); // 0=Sun … 6=Sat
    table.smallint('hour_pt').notNullable();     // 0-23
    table.smallint('minute_pt').notNullable();   // 0-59
  });

  // Burst analysis goes "for day X, hour Y, what's the queue growth at each
  // position band?" — this index is the lookup path.
  await knex.raw(`
    CREATE INDEX queue_snapshots_day_hour_idx
    ON queue_snapshots (day_of_week, hour_pt)
  `);

  // Recent time-series scans (e.g. last 2 weeks) for the admin UI / debugging.
  await knex.raw(`
    CREATE INDEX queue_snapshots_observed_at_idx
    ON queue_snapshots (observed_at DESC)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS queue_snapshots_observed_at_idx');
  await knex.raw('DROP INDEX IF EXISTS queue_snapshots_day_hour_idx');
  await knex.schema.dropTableIfExists('queue_snapshots');
};
