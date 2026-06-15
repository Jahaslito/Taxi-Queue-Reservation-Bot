const rateLimit = require('express-rate-limit');

/**
 * In test mode, rate limiting is skipped by default so functional tests can
 * make as many requests as they need without hitting the limit.
 *
 * rateLimit.test.js deliberately sets SKIP_RATE_LIMIT=false before its own
 * tests so the limiter is exercised there and only there.
 */
const skipInTest = () =>
  process.env.NODE_ENV === 'test' && process.env.SKIP_RATE_LIMIT !== 'false';

/** Applied to all login endpoints — limits brute-force attempts */
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             10,
  message:         { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            skipInTest,
});

/** Applied to the manual bot trigger endpoint — prevents accidental spam */
const triggerLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             5,
  message:         { error: 'Too many trigger requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            skipInTest,
});

/** Applied to all authenticated API routes — general abuse protection */
const apiLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             120,
  message:         { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            (req) => req.method === 'OPTIONS' || skipInTest(),
});

/**
 * Applied to the admin broadcast endpoint — a broadcast fans out to every
 * driver, so an accidental rapid double-send (or a runaway script) is costly.
 * Tighter than apiLimiter on purpose.
 */
const broadcastLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             10,
  message:         { error: 'Too many broadcasts. Please wait a moment before sending again.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            skipInTest,
});

module.exports = { loginLimiter, triggerLimiter, apiLimiter, broadcastLimiter };
