'use strict';

const { Router } = require('express');
const { param }  = require('express-validator');

const { authenticateAdmin } = require('../middleware/auth');
const { apiLimiter }        = require('../middleware/rateLimiter');
const validate              = require('../middleware/validate');
const ctrl                  = require('../controllers/watchlistController');

const router = Router();

router.use(apiLimiter);
router.use(authenticateAdmin);

// SSE live stream (lightweight init + state-change events)
router.get('/stream', ctrl.getStream);

// Aggregate stats
router.get('/stats', ctrl.getStats);

// Paginated driver list — supports ?page, ?limit, ?search, ?status, ?sortBy, ?sortDir
router.get('/', ctrl.getWatchlist);

// Manually trigger bot for a watched driver
router.post(
  '/run/:driverId',
  [param('driverId').isInt({ min: 1 }).withMessage('Invalid driver ID')],
  validate,
  ctrl.runBot,
);

module.exports = router;
