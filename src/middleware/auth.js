const jwt    = require('jsonwebtoken');
const Driver = require('../models/Driver');
const { jwtSecret: JWT_SECRET } = require('../config/env');

function extractToken(req) {
  return req.cookies?.token ?? null;
}

async function authenticateDriver(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'driver') return res.status(403).json({ error: 'Access denied' });

    const driver = await Driver.findById(decoded.id);
    if (!driver) {
      return res.status(401).json({ error: 'Account not found' });
    }
    // Billing-locked drivers (deactivated by the card-enforcement sweep because
    // their add-a-card grace window expired) carry a card_required_by stamp.
    // Unlike an admin deactivation, this is self-healable: let them through so
    // they can reach the billing screen and add a card. requireSubscription
    // still gates them out of every functional route (their status is past_due),
    // so the only thing they can do while locked is pay.
    if (!driver.is_active && !driver.card_required_by) {
      // 403 — they authenticated successfully but aren't permitted to use the
      // app. accountInactive flag lets the client render the dedicated
      // contact-admin screen instead of bouncing back to login.
      return res.status(403).json({
        error: 'Your account is inactive. Please contact the admin to reactivate it.',
        accountInactive: true,
      });
    }

    req.driverId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authenticateAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.adminId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function generateToken(id, role, expiresIn = '30d') {
  return jwt.sign({ id, role }, JWT_SECRET, { expiresIn });
}

module.exports = { authenticateDriver, authenticateAdmin, generateToken };
