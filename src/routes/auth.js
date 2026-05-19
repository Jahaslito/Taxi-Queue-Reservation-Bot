const { Router } = require('express');
const { body }   = require('express-validator');

const { loginLimiter }           = require('../middleware/rateLimiter');
const { authenticateDriver }     = require('../middleware/auth');
const validate                   = require('../middleware/validate');
const {
  registerDriver,
  loginDriver,
  loginAdmin,
  logout,
  forgotPassword,
  resetDriverPassword,
  verifyEmail,
  resendVerification,
} = require('../controllers/authController');

const router = Router();

// ─── Driver register ──────────────────────────────────────────────────────────
router.post(
  '/driver/register',
  loginLimiter,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('appPassword').notEmpty().withMessage('App password is required'),
    body('sanUsername').trim().notEmpty().withMessage('SAN username is required'),
    body('sanPassword').notEmpty().withMessage('SAN password is required'),
    body('vehicleNumber').trim().notEmpty().withMessage('Vehicle number is required'),
    body('scheduledTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage('scheduledTime must be a valid HH:MM time (00:00–23:59)'),
    body('scheduledDays')
      .optional({ checkFalsy: true })
      .matches(/^[0-6](,[0-6]){0,6}$/)
      .withMessage('scheduledDays must be comma-separated day numbers 0–6'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email format'),
  ],
  validate,
  registerDriver,
);

// ─── Driver login ─────────────────────────────────────────────────────────────
router.post(
  '/driver/login',
  loginLimiter,
  [
    body('appPassword').notEmpty().withMessage('Password is required'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email format'),
  ],
  validate,
  loginDriver,
);

// ─── Admin login ──────────────────────────────────────────────────────────────
router.post(
  '/admin/login',
  loginLimiter,
  [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  loginAdmin,
);

// ─── Email verification ───────────────────────────────────────────────────────
// GET link clicked from email — redirects back to the SPA with ?verified=success|expired
router.get('/driver/verify-email', verifyEmail);

// Resend verification (driver must be logged in)
router.post('/driver/resend-verification', authenticateDriver, resendVerification);

// ─── Password reset ───────────────────────────────────────────────────────────
// Step 1: request — sends email with reset link
router.post(
  '/driver/forgot-password',
  loginLimiter,
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  forgotPassword,
);

// Step 2: confirm — token + new password (linked from the reset email)
router.post(
  '/driver/reset-password',
  loginLimiter,
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  resetDriverPassword,
);

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', logout);

module.exports = router;
