/**
 * Driver messaging / announcements.
 *
 *   driver_messages            — one row per admin broadcast (blast or targeted).
 *                                Holds the message content + aggregate delivery
 *                                stats (filled in after push/SMS fan-out).
 *
 *   driver_message_recipients  — one row per (message, driver), created when the
 *                                admin sends. read_at tracks per-driver read
 *                                state — this is what powers the driver app's
 *                                bell badge (unread count) and inbox.
 *
 * Why expand recipients at send time instead of re-evaluating "all" on read?
 * It makes a driver's inbox a single indexed join, the unread count a single
 * indexed COUNT, and it snapshots exactly who a blast was for — a driver who
 * signs up *after* a blast correctly won't see it.
 *
 * admin_id has no FK — mirrors sos_alerts.acknowledged_by; the admins table is
 * sparse (single-admin systems may not have a row per id).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('driver_messages', (table) => {
    table.bigIncrements('id').primary();
    table.integer('admin_id'); // no FK — admins table is sparse
    table.string('title', 200).notNullable();
    table.text('body').notNullable();
    table.text('url'); // optional deep link opened on notification click

    // 'all'      — blast to every active driver at send time
    // 'selected' — only the driver ids the admin picked
    table.string('target_type', 16).notNullable().defaultTo('all');
    table.boolean('send_sms').notNullable().defaultTo(false);

    // Aggregate delivery counters — written after the fan-out completes. Kept on
    // the message (not derived) so the admin "sent history" needs no extra joins.
    table.integer('push_targeted').notNullable().defaultTo(0);
    table.integer('push_delivered').notNullable().defaultTo(0);
    table.integer('push_failed').notNullable().defaultTo(0);
    table.integer('sms_targeted').notNullable().defaultTo(0);
    table.integer('sms_sent').notNullable().defaultTo(0);
    table.integer('sms_failed').notNullable().defaultTo(0);

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('created_at');
  });

  await knex.schema.createTable('driver_message_recipients', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('message_id')
      .notNullable()
      .references('id').inTable('driver_messages')
      .onDelete('CASCADE');
    table.integer('driver_id')
      .notNullable()
      .references('id').inTable('drivers')
      .onDelete('CASCADE');

    // null = unread. Set to now() the first time the driver opens/taps it.
    table.timestamp('read_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    // One recipient row per driver per message — re-sends never duplicate.
    table.unique(['message_id', 'driver_id']);
    // Inbox list + unread count both filter by driver and read state.
    table.index(['driver_id', 'read_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('driver_message_recipients');
  await knex.schema.dropTableIfExists('driver_messages');
};
