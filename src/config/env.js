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

// Warn (don't hard-fail) when email vars are absent — emails will log to console in dev
if (process.env.NODE_ENV === 'production' && !process.env.RESEND_API_KEY) {
  console.warn('[env] WARNING: RESEND_API_KEY is not set — emails will not be sent in production');
}

module.exports = {
  port:           parseInt(process.env.PORT, 10) || 3000,
  nodeEnv:        process.env.NODE_ENV || 'development',
  jwtSecret:      process.env.JWT_SECRET,
  encryptionKey:  process.env.ENCRYPTION_KEY,
  databaseUrl:    process.env.DATABASE_URL,
  adminPassword:  process.env.ADMIN_PASSWORD || 'admin123',
  adminUsername:  process.env.ADMIN_USERNAME || 'admin',
  allowedOrigin:  process.env.ALLOWED_ORIGIN || '*',
  // Email (optional in dev — falls back to console logging)
  resendApiKey:   process.env.RESEND_API_KEY  || null,
  emailFrom:      process.env.EMAIL_FROM       || 'SAN Queue <noreply@sanqueue.com>',
  appUrl:         process.env.APP_URL          || 'http://localhost:3000',
};
