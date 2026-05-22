const { Router } = require('express');
const { body }   = require('express-validator');

const { authenticateDriver }    = require('../middleware/auth');
const { apiLimiter }            = require('../middleware/rateLimiter');
const requireSubscription       = require('../middleware/requireSubscription');
const validate                  = require('../middleware/validate');
const { getProfile, updateProfile, getLogs, getTodayStatus, triggerSelf } = require('../controllers/driverController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateDriver);

// Profile is intentionally NOT behind requireSubscription — the frontend needs
// it on boot to determine which state screen to show (verify email / billing).
router.get('/profile', getProfile);

// All other driver endpoints require a verified email + active subscription.
router.use(requireSubscription);

router.put(
  '/profile',
  [
    body('scheduledTime')
      .optional({ checkFalsy: true })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('scheduledTime must be a valid HH:MM time (00:00–23:59)'),
    body('scheduledDays')
      .optional({ checkFalsy: true })
      .matches(/^[0-6](,[0-6]){0,6}$/)
      .withMessage('scheduledDays must be comma-separated day numbers 0–6'),
    body('newAppPassword')
      .optional({ checkFalsy: true })
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters'),
    body('currentPassword')
      .optional({ checkFalsy: true })
      .notEmpty(),
  ],
  validate,
  updateProfile,
);

router.get('/logs',         getLogs);
router.get('/status/today', getTodayStatus);
router.post('/trigger',     triggerSelf);

module.exports = router;
