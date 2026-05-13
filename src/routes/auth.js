const { Router } = require('express');
const { body }   = require('express-validator');

const { loginLimiter }                    = require('../middleware/rateLimiter');
const validate                            = require('../middleware/validate');
const { registerDriver, loginDriver, loginAdmin } = require('../controllers/authController');

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
    body('scheduledTime').matches(/^\d{2}:\d{2}$/).withMessage('scheduledTime must be HH:MM format'),
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

module.exports = router;
