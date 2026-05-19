/**
 * Adds email verification and password-reset token columns to the drivers table.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    // Email verification
    table.timestamp('email_verified_at', { useTz: true }).nullable();
    table.string('email_verification_token', 64).nullable();
    table.timestamp('email_verification_expires_at', { useTz: true }).nullable();

    // Password reset
    table.string('password_reset_token', 64).nullable();
    table.timestamp('password_reset_expires_at', { useTz: true }).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function (knex) {
  await knex.schema.table('drivers', (table) => {
    table.dropColumn('email_verified_at');
    table.dropColumn('email_verification_token');
    table.dropColumn('email_verification_expires_at');
    table.dropColumn('password_reset_token');
    table.dropColumn('password_reset_expires_at');
  });
};
