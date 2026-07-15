// Adds drivers.last_payment_error — the human-readable reason Stripe gave for
// the most recent failed charge (e.g. "Your card has insufficient funds."),
// shown on the Payment Required screen and in the payment-failed email so
// drivers don't keep retrying the same bad card blind.
//
// Written by the invoice.payment_failed webhook (from the PaymentIntent's
// last_payment_error) and by the open-invoice sweeps; cleared on any
// successful payment / live subscription.

exports.up = (knex) =>
  knex.schema.alterTable('drivers', (table) => {
    table.string('last_payment_error', 300).nullable();
  });

exports.down = (knex) =>
  knex.schema.alterTable('drivers', (table) => {
    table.dropColumn('last_payment_error');
  });
