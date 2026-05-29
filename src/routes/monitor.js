'use strict';

const { Router } = require('express');
const { body, param } = require('express-validator');

const { authenticateAdmin } = require('../middleware/auth');
const { apiLimiter }        = require('../middleware/rateLimiter');
const validate              = require('../middleware/validate');
const ctrl                  = require('../controllers/monitorController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateAdmin);

// Current state snapshot
router.get('/status', ctrl.getStatus);

// SSE live stream
router.get('/stream', ctrl.getStream);

// Recent monitor_requeue logs
router.get('/history', ctrl.getHistory);

// Add a driver to the watch list
router.post(
  '/watch',
  [
    body('vehicleNumber').optional({ checkFalsy: true }).trim().isLength({ min: 1, max: 20 }),
    body('driverId').optional({ checkFalsy: true }).isInt({ min: 1 }),
  ],
  validate,
  ctrl.addWatch,
);

// Remove a driver from the watch list
router.delete(
  '/watch/:driverId',
  [param('driverId').isInt({ min: 1 }).withMessage('Invalid driver ID')],
  validate,
  ctrl.removeWatch,
);

// Re-arm the position scheduler so it can fire again today for this driver.
// Used after a manual run / early auto-requeue placed the driver at a non-
// target position and the admin wants the scheduler to retry at the real
// target later in the day.
router.post(
  '/watch/:driverId/allow-refire',
  [param('driverId').isInt({ min: 1 }).withMessage('Invalid driver ID')],
  validate,
  ctrl.allowRefire,
);

module.exports = router;
