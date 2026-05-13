const { nodeEnv } = require('../config/env');

/**
 * Centralised Express error handler.
 * All controllers call next(err) — this is the single place that formats
 * and sends error responses, ensuring nothing internal leaks in production.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;

  // Only expose internal error details outside production
  const message = statusCode < 500
    ? err.message
    : nodeEnv === 'production' ? 'An unexpected error occurred' : err.message;

  if (statusCode >= 500) {
    console.error(`[Error] ${req.method} ${req.path} →`, err);
  }

  res.status(statusCode).json({ error: message });
}

module.exports = errorHandler;
