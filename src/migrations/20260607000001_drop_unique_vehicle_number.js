'use strict';

/**
 * Makes vehicle_number non-unique in the drivers table.
 *
 * Reason: some drivers lease cabs and may share a vehicle number while
 * operating at different times. Enforcing uniqueness at the DB level
 * incorrectly prevents those drivers from being registered.
 *
 * The original constraint was added by 20260523000000_unique_vehicle_number.js.
 *
 * NOTE: any application-level duplicate check on vehicle_number (e.g. in
 * addDriver / updateDriver) should also be relaxed or removed after this
 * migration runs.
 */
exports.up = async (knex) => {
  await knex.schema.table('drivers', (t) => {
    t.dropUnique(['vehicle_number']);
  });
};

exports.down = async (knex) => {
  await knex.schema.table('drivers', (t) => {
    t.unique(['vehicle_number']);
  });
};
