const rateLimit = require('express-rate-limit');

/** Applied to all login endpoints — limits brute-force attempts */
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             10,
  message:         { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

/** Applied to the manual bot trigger endpoint — prevents accidental spam */
const triggerLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             5,
  message:         { error: 'Too many trigger requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

module.exports = { loginLimiter, triggerLimiter };
