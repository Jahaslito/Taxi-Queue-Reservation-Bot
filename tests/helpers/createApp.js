/**
 * Builds the Express application without calling bootstrap() or app.listen().
 *
 * Why not import server.js?
 *   server.js calls bootstrap() at module load time, which runs migrations
 *   against DATABASE_URL and starts an HTTP server on port 3000. In tests we
 *   manage migrations ourselves and supertest binds its own ephemeral port.
 *
 * This factory mirrors the middleware stack in server.js exactly so tests
 * exercise the same request pipeline as production.
 */
const express      = require('express');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const errorHandler = require('../../src/middleware/errorHandler');

function createApp() {
  const app = express();

  // Security headers — included so tests catch any CSP regressions
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: false, // CSP is irrelevant for API JSON responses
  }));

  app.use(express.json());
  app.use(cookieParser());

  // All API routes — same as server.js
  app.use('/api/auth',   require('../../src/routes/auth'));
  app.use('/api/driver', require('../../src/routes/driver'));
  app.use('/api/admin',  require('../../src/routes/admin'));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Centralised error handler must be last
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
