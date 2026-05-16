const { Router } = require('express');
const { body }   = require('express-validator');

const { loginLimiter }                                                      = require('../middleware/rateLimiter');
const validate                                                              = require('../middleware/validate');
const { registerDriver, loginDriver, loginAdmin, logout, resetDriverPassword } = require('../controllers/authController');

const router = Router();

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

router.post(
  '/driver/reset-password',
  loginLimiter,
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  resetDriverPassword,
);

router.post('/logout', logout);

module.exports = router;
