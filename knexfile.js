require('dotenv').config();

/** @type {import('knex').Knex.Config} */
const base = {
  client: 'pg',
  migrations: {
    directory: './src/migrations',
    tableName:  'knex_migrations',
  },
};

module.exports = {
  development: {
    ...base,
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 10 },
  },

  test: {
    ...base,
    connection: process.env.DATABASE_URL, // env.js points this at TEST_DATABASE_URL
    pool: { min: 1, max: 5 },
  },

  production: {
    ...base,
    connection: {
      connectionString: process.env.DATABASE_URL,
      // SSL is required for managed cloud databases (Neon, Supabase, Railway, DO Managed PG).
      // Set DATABASE_SSL=false when running against a local/Docker Postgres on the same host.
      ...(process.env.DATABASE_SSL !== 'false' && {
        ssl: { rejectUnauthorized: false },
      }),
    },
    pool: { min: 2, max: 20 },
  },
};
