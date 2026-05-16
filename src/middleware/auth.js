const jwt = require('jsonwebtoken');
const { jwtSecret: JWT_SECRET } = require('../config/env');

function extractToken(req) {
  return req.cookies?.token || req.headers.authorization?.split(' ')[1];
}

function authenticateDriver(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'driver') return res.status(403).json({ error: 'Access denied' });
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
