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

  production: {
    ...base,
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required by Neon / Supabase / Railway
    },
    pool: { min: 2, max: 20 },
  },
};
