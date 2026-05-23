const { Router } = require('express');
const { body, param, query } = require('express-validator');

const { authenticateAdmin }          = require('../middleware/auth');
const { triggerLimiter, apiLimiter } = require('../middleware/rateLimiter');
const validate               = require('../middleware/validate');
const adminController        = require('../controllers/adminController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateAdmin);

const idParam = param('id').isInt({ min: 1 }).withMessage('Driver ID must be a positive integer');

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

router.get(
  '/position-tracking',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  adminController.getPositionTracking,
);

router.get(
  '/logs',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('search').optional().trim().isLength({ max: 100 }),
    query('date').optional().isDate().withMessage('date must be YYYY-MM-DD'),
    query('status').optional().isIn(['success', 'already_queued', 'failed', 'pending'])
      .withMessage('Invalid status value'),
  ],
  validate,
  adminController.getLogs,
);

module.exports = router;
