/**
 * Loaded by Jest's `setupFiles` before any test module is required.
 * Reads .env.test and wires DATABASE_URL → TEST_DATABASE_URL so every
 * Knex/model import in tests automatically hits the test database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test'), override: true });

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set.\n' +
    'Copy .env.test, fill in your test database URL, and try again.',
  );
}

// Redirect the app's DATABASE_URL to the test DB
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// Tell Knex and the app which config block to use
process.env.NODE_ENV = 'test';
