/**
 * Adds place_name to sos_alerts — reverse-geocoded human-readable address
 * for the latest known fix on each alert. Populated asynchronously by
 * geocodingService.js (no extra column needed for "geocoded_at"; nullable
 * place_name is the unset signal).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('sos_alerts', (table) => {
    table.text('place_name');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('sos_alerts', (table) => {
    table.dropColumn('place_name');
  });
};
