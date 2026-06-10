/**
 * SOS feature — emergency alerts from drivers to admins.
 *
 * Three tables:
 *
 *   sos_alerts            — one row per alert. Status moves through
 *                           active → acknowledged → resolved. Initial location
 *                           is captured at creation; latest_* fields are updated
 *                           in place when live tracking is enabled so the admin
 *                           map always shows the most recent fix without a join.
 *
 *   sos_location_history  — append-only trail of GPS fixes for an alert when
 *                           the driver opts into live tracking. Lets the admin
 *                           replay movement after the fact.
 *
 *   push_subscriptions    — Web Push endpoints for admin browsers. Keyed by
 *                           endpoint (unique) so the same browser re-subscribing
 *                           upserts cleanly.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('sos_alerts', (table) => {
    table.bigIncrements('id').primary();
    table.integer('driver_id')
      .notNullable()
      .references('id').inTable('drivers')
      .onDelete('CASCADE');

    // active        — driver pressed SOS, no admin has claimed it yet
    // acknowledged  — an admin has claimed it and is handling
    // resolved      — closed by admin OR cancelled by driver
    table.string('status', 16).notNullable().defaultTo('active');

    // Initial GPS fix — may be null if geolocation failed or was denied.
    // We never block the alert on getting coords; the driver in trouble matters
    // more than perfect data.
    table.decimal('initial_lat', 10, 7);
    table.decimal('initial_lng', 10, 7);
    table.decimal('initial_accuracy', 8, 2);

    // Latest fix — updated in place when live_tracking=true and the driver's
    // browser pushes a new position. Lets the admin list query render the
    // current location without a sub-query into the history table.
    table.decimal('latest_lat', 10, 7);
    table.decimal('latest_lng', 10, 7);
    table.decimal('latest_accuracy', 8, 2);
    table.timestamp('latest_location_at');

    table.boolean('live_tracking').notNullable().defaultTo(false);
    table.text('message'); // optional free-text from the driver

    // Resolution state. Null on cancellation by the driver, in which case
    // resolution_reason is set to 'driver_cancelled'.
    table.integer('acknowledged_by'); // admin id (no FK — admins table is sparse)
    table.timestamp('acknowledged_at');
    table.integer('resolved_by');     // admin id, or null if cancelled
    table.timestamp('resolved_at');
    table.string('resolution_reason', 32); // 'admin_resolved' | 'driver_cancelled'

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('status');
    table.index(['status', 'created_at']);
    table.index('driver_id');
  });

  await knex.schema.createTable('sos_location_history', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('alert_id')
      .notNullable()
      .references('id').inTable('sos_alerts')
      .onDelete('CASCADE');
    table.decimal('lat', 10, 7).notNullable();
    table.decimal('lng', 10, 7).notNullable();
    table.decimal('accuracy', 8, 2);
    table.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now());

    table.index(['alert_id', 'recorded_at']);
  });

  await knex.schema.createTable('push_subscriptions', (table) => {
    table.increments('id').primary();
    table.string('role', 16).notNullable(); // 'admin' for now; reserved for future
    table.integer('subscriber_id');         // admin id (nullable — single-admin systems)
    table.text('endpoint').notNullable();
    table.text('p256dh_key').notNullable();
    table.text('auth_key').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_used_at');

    table.unique('endpoint'); // re-subscribes upsert cleanly
    table.index(['role', 'subscriber_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('push_subscriptions');
  await knex.schema.dropTableIfExists('sos_location_history');
  await knex.schema.dropTableIfExists('sos_alerts');
};
