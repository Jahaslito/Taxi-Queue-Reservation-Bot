/**
 * Validates required environment variables at startup.
 * The server refuses to start if any are missing.
 */
const required = ['JWT_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  port:           parseInt(process.env.PORT, 10) || 3000,
  nodeEnv:        process.env.NODE_ENV || 'development',
  jwtSecret:      process.env.JWT_SECRET,
  encryptionKey:  process.env.ENCRYPTION_KEY,
  databaseUrl:    process.env.DATABASE_URL,
  adminPassword:  process.env.ADMIN_PASSWORD || 'admin123',
  allowedOrigin:  process.env.ALLOWED_ORIGIN || '*',
};
