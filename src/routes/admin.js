const { Router } = require('express');
const { body, param, query } = require('express-validator');
const multer = require('multer');
const crypto = require('crypto');
const path   = require('path');

const { authenticateAdmin, restrictInsuranceRole }   = require('../middleware/auth');
const { triggerLimiter, apiLimiter, broadcastLimiter } = require('../middleware/rateLimiter');
const validate               = require('../middleware/validate');
const adminController        = require('../controllers/adminController');
const sosController          = require('../controllers/sosController');
const adminMessagesController = require('../controllers/adminMessagesController');
const insuranceController    = require('../controllers/insuranceController');
const InsuranceDocument      = require('../models/InsuranceDocument');

// ─── Insurance document uploads (multipart → disk, metadata in DB) ─────────────
// Bytes land in InsuranceDocument.UPLOAD_DIR under a random, app-generated name
// (the original name is never used to build a path). Only insurance-relevant
// types are accepted; 20 MB / 20 files per request.
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
]);
const insuranceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, InsuranceDocument.UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 12).replace(/[^.\w]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME.has(file.mimetype)) return cb(null, true);
    const err = new Error(`Unsupported file type: ${file.mimetype}`);
    err.statusCode = 400;
    cb(err);
  },
}).array('files', 20);

// Run multer and normalise its errors (size/count/type) to clean 400s.
function handleInsuranceUpload(req, res, next) {
  insuranceUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE')  err.message = 'A file exceeds the 20 MB limit';
    if (err.code === 'LIMIT_FILE_COUNT') err.message = 'Too many files (max 20 per upload)';
    if (!err.statusCode) err.statusCode = 400;
    next(err);
  });
}

const router = Router();

router.use(apiLimiter);
router.use(authenticateAdmin);
router.use(restrictInsuranceRole);   // 'insurance' role is confined to /insurance/* (+ /me)

// ─── Session / identity ───────────────────────────────────────────────────────
// Role-aware session probe used by the admin SPA on boot. Available to every
// authenticated admin (both roles) so the client can decide what to render.
router.get('/me', (req, res) => {
  res.json({ id: req.adminId, username: req.admin?.username, role: req.adminRole });
});

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

// Hard delete — permanently removes the driver row + all history (cascade) plus
// their polymorphic push subscriptions. Distinct from the soft-delete DELETE
// route above. POST (not DELETE) so the two destructive levels stay unambiguous.
router.post(
  '/drivers/:id/delete',
  [idParam],
  validate,
  adminController.deleteDriver,
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

// Per-terminal dwell & requeue-latency metrics (T1 vs T2 diagnostics).
router.get(
  '/terminal-metrics',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  adminController.getTerminalMetrics,
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

// Rescue a borrowed probe driver that appears stuck: force-retire the probe
// (force-removes the vehicle from SAN), exclude from borrowing today, and
// re-arm the scheduler so they still get their real target. Also invoked by
// scripts/rescueBorrowedDriver.js.
router.post(
  '/drivers/:id/rescue-borrow',
  [idParam],
  validate,
  adminController.rescueBorrowedDriver,
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

// ─── Insurance module (Phase 1 — reporting) ────────────────────────────────────
// All read-only except the audited DL reveals. DL numbers are masked in every
// list response; a reveal writes an insurance_access_log row.
const pageQuery = [
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  query('search').optional().trim().isLength({ max: 100 }),
];

router.get('/insurance/overview', insuranceController.getOverview);

router.get(
  '/insurance/vehicles',
  [
    ...pageQuery,
    query('company').optional().trim().isLength({ max: 120 }),
    query('make').optional().trim().isLength({ max: 60 }),
    query('status').optional({ checkFalsy: true }).isIn(['on', 'off']).withMessage('status must be "on" or "off"'),
  ],
  validate,
  insuranceController.listVehicles,
);

router.get(
  '/insurance/drivers',
  [
    ...pageQuery,
    query('needsMedical').optional().isBoolean(),
    query('noDriver').optional().isBoolean(),
    query('missingDob').optional().isBoolean(),
  ],
  validate,
  insuranceController.listDrivers,
);

router.get('/insurance/claims', [...pageQuery], validate, insuranceController.listClaims);
router.get('/insurance/endorsements', [...pageQuery], validate, insuranceController.listEndorsements);
router.get('/insurance/reconciliation', insuranceController.getReconciliation);

// Documents — upload (single/multiple/bulk), list, download, preview, delete.
router.get('/insurance/documents', [...pageQuery], validate, insuranceController.listDocuments);
router.post('/insurance/documents', handleInsuranceUpload, insuranceController.uploadDocuments);
router.get('/insurance/documents/:id/download', [idParam], validate, insuranceController.downloadDocument);
router.get('/insurance/documents/:id/preview',  [idParam], validate, insuranceController.previewDocument);
router.delete('/insurance/documents/:id', [idParam], validate, insuranceController.deleteDocument);

// Audited full-DL reveal (POST — an explicit action, not a passive read).
router.post(
  '/insurance/drivers/:id/reveal-dl',
  [idParam],
  validate,
  insuranceController.revealDriverDl,
);
router.post(
  '/insurance/endorsements/:id/reveal-dl',
  [idParam],
  validate,
  insuranceController.revealEndorsementDl,
);

module.exports = router;
