// ─── requireSubscription middleware ──────────────────────────────────────────
// Applied to all driver routes that require an active subscription.
// GET /api/driver/profile is intentionally excluded (the frontend needs it to
// determine which state screen to show).
//
// Set BILLING_ENABLED=false in .env to bypass all billing/verification checks
// (useful for staging / soft-launch). Defaults to true.
//
// Returns:
//   403 { error: 'email_not_verified' }   — email not yet verified
//   402 { error: 'subscription_required' } — no active subscription

const Driver = require('../models/Driver');

const BILLING_ENABLED = process.env.BILLING_ENABLED !== 'false';
const ACTIVE_STATUSES = ['trialing', 'active'];

async function requireSubscription(req, res, next) {
  if (!BILLING_ENABLED) return next();

  try {
    const driver = await Driver.findById(req.driverId);
    if (!driver) return res.status(401).json({ error: 'Driver not found' });

    if (!driver.email_verified_at) {
      return res.status(403).json({
        error:   'email_not_verified',
        message: 'Please verify your email address to continue.',
      });
    }

    if (!ACTIVE_STATUSES.includes(driver.subscription_status)) {
      return res.status(402).json({
        error:              'subscription_required',
        message:            'An active subscription is required to use this service.',
        subscriptionStatus: driver.subscription_status || null,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireSubscription;
