const { Router } = require('express');
const { body }   = require('express-validator');

const { authenticateDriver }    = require('../middleware/auth');
const { apiLimiter }            = require('../middleware/rateLimiter');
const requireSubscription       = require('../middleware/requireSubscription');
const validate                  = require('../middleware/validate');
const { getProfile, updateProfile, getLogs, getTodayStatus, triggerSelf, removeFromQueue, removeFromRedZone } = require('../controllers/driverController');
const sosController             = require('../controllers/sosController');
const driverPushController      = require('../controllers/driverPushController');
const driverMessagesController  = require('../controllers/driverMessagesController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateDriver);

// Profile is intentionally NOT behind requireSubscription — the frontend needs
// it on boot to determine which state screen to show (verify email / billing).
router.get('/profile', getProfile);

// SOS endpoints — INTENTIONALLY bypass requireSubscription. A driver in
// trouble must be able to summon help regardless of email verification or
// billing status. Auth is still required (authenticateDriver above).
router.post('/sos',                       sosController.create);
router.get( '/sos/open',                  sosController.getOpenForDriver);
router.post('/sos/:id/location',          sosController.pushLocation);
router.post('/sos/:id/live-tracking',     sosController.setLiveTracking);
router.post('/sos/:id/cancel',            sosController.cancel);

// Driver messages / announcements — INTENTIONALLY bypass requireSubscription so
// the admin can always reach a driver (account notices, billing reminders,
// outage alerts) even if their email is unverified or their subscription lapsed.
// Auth is still required (authenticateDriver above).
// '/messages/read-all' is declared before '/messages/:id/read' to read clearly,
// though the paths don't actually collide (different segment counts).
router.get( '/messages',              driverMessagesController.list);
router.get( '/messages/unread-count', driverMessagesController.unreadCount);
router.post('/messages/read-all',     driverMessagesController.markAllRead);
router.post('/messages/:id/read',     driverMessagesController.markRead);

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

router.get('/logs',          getLogs);
router.get('/status/today',  getTodayStatus);
router.post('/trigger',      triggerSelf);
router.post('/remove-queue',   removeFromQueue);
router.post('/redzone-remove', removeFromRedZone);

// Dispatch push notifications — opt-in per device.
router.get( '/push/config',       driverPushController.config);
router.post('/push/subscribe',    driverPushController.subscribe);
router.post('/push/unsubscribe',  driverPushController.unsubscribe);

module.exports = router;
