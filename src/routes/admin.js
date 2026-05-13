const { Router } = require('express');
const { body }   = require('express-validator');

const { authenticateAdmin }  = require('../middleware/auth');
const { triggerLimiter }     = require('../middleware/rateLimiter');
const validate               = require('../middleware/validate');
const adminController        = require('../controllers/adminController');

const router = Router();

router.use(authenticateAdmin);

router.get('/stats', adminController.getStats);

router.get('/drivers',     adminController.listDrivers);
router.get('/drivers/:id', adminController.getDriver);

router.post(
  '/drivers',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('sanUsername').trim().notEmpty().withMessage('SAN username is required'),
    body('sanPassword').notEmpty().withMessage('SAN password is required'),
    body('vehicleNumber').trim().notEmpty().withMessage('Vehicle number is required'),
    body('scheduledTime').matches(/^\d{2}:\d{2}$/).withMessage('scheduledTime must be HH:MM format'),
  ],
  validate,
  adminController.addDriver,
);

router.put('/drivers/:id',    adminController.updateDriver);
router.delete('/drivers/:id', adminController.deactivateDriver);

router.post('/drivers/:id/trigger', triggerLimiter, adminController.triggerDriver);

router.get('/logs', adminController.getLogs);

module.exports = router;
