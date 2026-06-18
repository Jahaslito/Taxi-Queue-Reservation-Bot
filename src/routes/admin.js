const { Router } = require('express');
const { body, param, query } = require('express-validator');

const { authenticateAdmin }                          = require('../middleware/auth');
const { triggerLimiter, apiLimiter, broadcastLimiter } = require('../middleware/rateLimiter');
const validate               = require('../middleware/validate');
const adminController        = require('../controllers/adminController');
const sosController          = require('../controllers/sosController');
const adminMessagesController = require('../controllers/adminMessagesController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateAdmin);

// ─── SOS ──────────────────────────────────────────────────────────────────────
router.get( '/sos',                       sosController.adminList);
router.get( '/sos/stream',                sosController.adminStream);
router.get( '/sos/push/config',           sosController.adminPushConfig);
router.post('/sos/push/subscribe',        sosController.adminPushSubscribe);
router.post('/sos/push/unsubscribe',      sosController.adminPushUnsubscribe);
router.get( '/sos/:id',                   sosController.adminGet);
router.post('/sos/:id/acknowledge',       sosController.adminAcknowledge);
router.post('/sos/:id/resolve',           sosController.adminResolve);

const idParam = param('id').isInt({ min: 1 }).withMessage('Driver ID must be a positive integer');

// ─── Driver Messages (broadcast) ───────────────────────────────────────────────
router.get(
  '/messages',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  adminMessagesController.listMessages,
);

router.post(
  '/messages/broadcast',
  broadcastLimiter,
  [
    body('title').trim().notEmpty().withMessage('Title is required')
      .isLength({ max: 100 }).withMessage('Title must be 100 characters or fewer'),
    body('body').trim().notEmpty().withMessage('Message is required')
      .isLength({ max: 1000 }).withMessage('Message must be 1000 characters or fewer'),
    body('driverIds').optional().isArray().withMessage('driverIds must be an array'),
    body('driverIds.*').optional().isInt({ min: 1 }).withMessage('driverIds must be positive integers'),
    body('sendSms').optional().isBoolean().withMessage('sendSms must be a boolean'),
    body('url').optional({ checkFalsy: true }).isString().isLength({ max: 300 })
      .withMessage('url must be 300 characters or fewer'),
  ],
  validate,
  adminMessagesController.broadcast,
);

router.get('/stats', adminController.getStats);

router.post(
  '/positions/check',
  [
    body('dayPositions').isString().notEmpty().withMessage('dayPositions is required'),
    body('driverId').optional().isInt({ min: 0 }),
  ],
  validate,
  adminController.checkPositions,
);

router.get(
  '/drivers',
  [query('search').optional().trim().isLength({ max: 100 })],
  validate,
  adminController.listDrivers,
);

router.get(
  '/drivers/:id',
  [idParam],
  validate,
  adminController.getDriver,
);

router.post(
  '/drivers',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('sanUsername').trim().notEmpty().withMessage('SAN username is required'),
    body('sanPassword').notEmpty().withMessage('SAN password is required'),
    body('vehicleNumber').trim().notEmpty().withMessage('Vehicle number is required'),
    body('scheduledTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage('scheduledTime must be a valid HH:MM time (00:00–23:59)'),
    body('scheduledDays')
      .optional({ checkFalsy: true })
      .matches(/^[0-6](,[0-6]){0,6}$/)
      .withMessage('scheduledDays must be comma-separated day numbers 0–6'),
    body('maxAcceptablePosition')
      .optional({ nullable: true })
      .isInt({ min: 1, max: 1000 })
      .withMessage('maxAcceptablePosition must be an integer between 1 and 1000'),
  ],
  validate,
  adminController.addDriver,
);

router.put(
  '/drivers/:id',
  [
    idParam,
    body('scheduledDays')
      .optional({ checkFalsy: true })
      .matches(/^[0-6](,[0-6]){0,6}$/)
      .withMessage('scheduledDays must be comma-separated day numbers 0–6'),
    body('maxAcceptablePosition')
      .optional({ nullable: true })
      .isInt({ min: 1, max: 1000 })
      .withMessage('maxAcceptablePosition must be an integer between 1 and 1000'),
  ],
  validate,
  adminController.updateDriver,
);

router.delete(
  '/drivers/:id',
  [idParam],
  validate,
  adminController.deactivateDriver,
);

router.post(
  '/drivers/:id/trigger',
  [idParam],
  validate,
  triggerLimiter,
  adminController.triggerDriver,
);

router.post(
  '/drivers/:id/send-reset',
  [idParam],
  validate,
  adminController.sendDriverPasswordReset,
);

// Manually clear a driver's day-scoped credential lockout (escape hatch for
// when the SAN password is confirmed fine and the bot should retry now).
router.post(
  '/drivers/:id/unlock-credentials',
  [idParam],
  validate,
  adminController.unlockCredentials,
);

// Live SAN login test — confirm a driver's stored credentials actually work.
router.post(
  '/drivers/:id/verify-credentials',
  [idParam],
  validate,
  adminController.verifyDriverCredentials,
);

// Lock a driver out until they add a card on file (manual card enforcement).
router.post(
  '/drivers/:id/require-card',
  [idParam],
  validate,
  adminController.requireCard,
);

// Clear a card requirement (admin waiver / undo a mistaken lock).
router.post(
  '/drivers/:id/clear-card-requirement',
  [idParam],
  validate,
  adminController.clearCardRequirement,
);

router.get(
  '/position-tracking',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  adminController.getPositionTracking,
);

// Daily position-scheduler report — defaults to today PT, accepts 'today',
// 'yesterday', or any YYYY-MM-DD. Returns rows + summary in one response.
router.get(
  '/reports/positions/:date?',
  [
    param('date')
      .optional()
      .matches(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/)
      .withMessage('date must be YYYY-MM-DD, "today", or "yesterday"'),
  ],
  validate,
  adminController.getDailyReport,
);

// Overnight carryover-removal report — confirms leftover drivers were pulled
// from yesterday's queue and shows whether they then hit today's target.
router.get(
  '/reports/carryover/:date?',
  [
    param('date')
      .optional()
      .matches(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/)
      .withMessage('date must be YYYY-MM-DD, "today", or "yesterday"'),
  ],
  validate,
  adminController.getCarryoverReport,
);

// Early-join diagnostics — live state + 14-day history of skip_already_seen
router.get('/position-diagnostics', adminController.getPositionDiagnostics);

// Re-arm the position scheduler for a single driver (clears positionFiredToday +
// early-join fields). Equivalent to the 3 AM auto-arm for one driver.
router.post(
  '/drivers/:id/rearm-position',
  [idParam],
  validate,
  adminController.rearmPositionScheduler,
);

router.get(
  '/logs',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('search').optional().trim().isLength({ max: 100 }),
    query('date').optional().isDate().withMessage('date must be YYYY-MM-DD'),
    query('status').optional().isIn(['success', 'already_queued', 'failed', 'pending', 'info'])
      .withMessage('Invalid status value'), // 'info' = carryover markers (Overnight carryover filter)
  ],
  validate,
  adminController.getLogs,
);

module.exports = router;
