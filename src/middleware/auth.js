const jwt    = require('jsonwebtoken');
const Driver = require('../models/Driver');
const Admin  = require('../models/Admin');
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

async function authenticateAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    // Resolve the admin's ACCESS role (super_admin | insurance) from the DB on
    // every request rather than trusting the long-lived token, so a role change
    // or a deleted account takes effect immediately.
    const admin = await Admin.findById(decoded.id);
    if (!admin) return res.status(401).json({ error: 'Account not found' });

    req.adminId   = decoded.id;
    req.admin     = admin;
    req.adminRole = admin.role || 'super_admin';
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Scope gate for the limited 'insurance' role: it may reach ONLY the insurance
// portal endpoints (and /me); every other admin endpoint is 403. Uses
// originalUrl so it works identically no matter which admin sub-router
// (admin / monitor / watchlist) mounts it. Must run AFTER authenticateAdmin.
function restrictInsuranceRole(req, res, next) {
  if (req.adminRole !== 'insurance') return next();   // super_admin → full access
  const path = (req.originalUrl.split('?')[0] || '').replace(/\/+$/, '') || '/';
  const allowed =
    path === '/api/admin/me' ||
    path === '/api/admin/insurance' ||
    path.startsWith('/api/admin/insurance/');
  if (!allowed) return res.status(403).json({ error: 'Access restricted to the insurance portal' });
  next();
}

function generateToken(id, role, expiresIn = '30d') {
  return jwt.sign({ id, role }, JWT_SECRET, { expiresIn });
}

module.exports = { authenticateDriver, authenticateAdmin, restrictInsuranceRole, generateToken };
