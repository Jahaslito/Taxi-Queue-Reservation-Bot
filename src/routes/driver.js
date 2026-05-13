const { Router } = require('express');
const { body }   = require('express-validator');

const { authenticateDriver }                            = require('../middleware/auth');
const validate                                          = require('../middleware/validate');
const { getProfile, updateProfile, getLogs, getTodayStatus } = require('../controllers/driverController');

const router = Router();

router.use(authenticateDriver);

router.get('/profile', getProfile);

router.put(
  '/profile',
  [
    body('scheduledTime')
      .optional({ checkFalsy: true })
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('scheduledTime must be HH:MM format'),
  ],
  validate,
  updateProfile,
);

router.get('/logs',         getLogs);
router.get('/status/today', getTodayStatus);

module.exports = router;
