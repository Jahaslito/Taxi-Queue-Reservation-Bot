const bcrypt            = require('bcryptjs');
const crypto            = require('crypto');
const Driver            = require('../models/Driver');
const Admin             = require('../models/Admin');
const { encrypt }       = require('../services/cryptoService');
const { generateToken } = require('../middleware/auth');
const { nodeEnv, appUrl: APP_URL_ENV } = require('../config/env');
const { sendVerificationEmail, sendPasswordResetEmail, APP_URL } = require('../services/emailService');
const stripeService     = require('../services/stripeService');

// ─── Token helpers ────────────────────────────────────────────────────────────
function makeToken()  { return crypto.randomBytes(32).toString('hex'); }
function hoursFromNow(h) { return new Date(Date.now() + h * 60 * 60 * 1000); }

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   nodeEnv === 'production',
};

async function registerDriver(req, res, next) {
  try {
    const { name, phone, email, appPassword, sanUsername, sanPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules } = req.body;

    if (email) {
      const existing = await Driver.findByEmail(email);
      if (existing) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }
    }

    // Build day_schedules JSON
    let daySchedulesJson;
    if (daySchedules) {
      daySchedulesJson = daySchedules; // already a JSON string from frontend
    } else {
      const activeDays = (scheduledDays || '0,1,2,3,4,5,6').split(',').map(String);
      const ds = {};
      for (let d = 0; d < 7; d++) {
        ds[String(d)] = activeDays.includes(String(d)) ? (scheduledTime || '05:00') : null;
      }
      daySchedulesJson = JSON.stringify(ds);
    }

    // Build verification token if email supplied
    const verificationToken   = email ? makeToken()       : null;
    const verificationExpires = email ? hoursFromNow(24)  : null;

    const driver = await Driver.create({
      name,
      phone:                          phone        || null,
      email:                          email        || null,
      app_password:                   await bcrypt.hash(appPassword, 10),
      san_username:                   sanUsername,
      san_password:                   encrypt(sanPassword),
      vehicle_number:                 vehicleNumber,
      scheduled_time:                 scheduledTime,
      scheduled_days:                 scheduledDays || '0,1,2,3,4,5,6',
      day_schedules:                  daySchedulesJson,
      email_verification_token:       verificationToken,
      email_verification_expires_at:  verificationExpires,
    });

    // Send verification email (non-blocking — a failure here shouldn't break registration)
    if (email && verificationToken) {
      sendVerificationEmail(driver, verificationToken).catch((err) =>
        console.error('[Email] Failed to send verification email:', err.message),
      );
    }

    const token = generateToken(driver.id, 'driver');
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.status(201).json({ driver });
  } catch (err) {
    next(err);
  }
}

async function loginDriver(req, res, next) {
  try {
    const { email, vehicleNumber, appPassword } = req.body;

    const record = email
      ? await Driver.findByEmail(email)
      : await Driver.findByVehicleNumber(vehicleNumber);

    // Fetch full record (with hashed password) only after we know the driver exists
    const driver = record ? await Driver.findByIdWithCredentials(record.id) : null;

    const passwordMatch = driver && await bcrypt.compare(appPassword, driver.app_password);
    if (!driver || !passwordMatch) {
      const err = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    const token = generateToken(driver.id, 'driver');
    const { app_password, san_password, ...safeDriver } = driver;
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ driver: safeDriver });
  } catch (err) {
    next(err);
  }
}

async function loginAdmin(req, res, next) {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findByUsername(username);
    const passwordMatch = admin && await bcrypt.compare(password, admin.password_hash);

    if (!admin || !passwordMatch) {
      const err = new Error('Invalid admin credentials');
      err.statusCode = 401;
      throw err;
    }

    const token = generateToken(admin.id, 'admin', '7d');
    res.cookie('token', token, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    next(err);
  }
}

// ─── Forgot password — send reset link via email ──────────────────────────────
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const driver = await Driver.findByEmail(email);

    // Always return the same response to prevent email enumeration
    const genericOk = { message: 'If that email is registered, you will receive a reset link shortly.' };

    if (!driver) return res.json(genericOk);

    const resetToken   = makeToken();
    const resetExpires = hoursFromNow(1);

    await Driver.update(driver.id, {
      password_reset_token:      resetToken,
      password_reset_expires_at: resetExpires,
    });

    sendPasswordResetEmail(driver, resetToken).catch((err) =>
      console.error('[Email] Failed to send reset email:', err.message),
    );

    res.json(genericOk);
  } catch (err) {
    next(err);
  }
}

// ─── Reset password — confirm with token + new password ──────────────────────
async function resetDriverPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body;

    const driver = token ? await Driver.findByResetToken(token) : null;

    if (!driver || !driver.password_reset_expires_at || new Date() > new Date(driver.password_reset_expires_at)) {
      const err = new Error('Reset link is invalid or has expired.');
      err.statusCode = 400;
      throw err;
    }

    await Driver.update(driver.id, {
      app_password:              await bcrypt.hash(newPassword, 10),
      password_reset_token:      null,
      password_reset_expires_at: null,
    });

    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

// ─── Verify email — called via link in the verification email ─────────────────
async function verifyEmail(req, res) {
  const { token } = req.query;
  const driver = token ? await Driver.findByVerificationToken(token) : null;

  if (!driver || !driver.email_verification_expires_at || new Date() > new Date(driver.email_verification_expires_at)) {
    return res.redirect(`${APP_URL}/?verified=expired`);
  }

  await Driver.update(driver.id, {
    email_verified_at:              new Date(),
    email_verification_token:       null,
    email_verification_expires_at:  null,
  });

  res.redirect(`${APP_URL}/?verified=success`);
}

// ─── Resend verification email (requires driver to be logged in) ──────────────
async function resendVerification(req, res, next) {
  try {
    const driver = await Driver.findById(req.driverId);

    if (!driver.email) {
      const err = new Error('No email address on your account.');
      err.statusCode = 400;
      throw err;
    }
    if (driver.email_verified_at) {
      return res.json({ message: 'Email is already verified.' });
    }

    const verificationToken   = makeToken();
    const verificationExpires = hoursFromNow(24);

    await Driver.update(driver.id, {
      email_verification_token:      verificationToken,
      email_verification_expires_at: verificationExpires,
    });

    await sendVerificationEmail(driver, verificationToken);
    res.json({ message: 'Verification email sent.' });
  } catch (err) {
    next(err);
  }
}

// ─── Create Stripe Checkout Session ──────────────────────────────────────────
// Returns { url } — the frontend redirects the driver to Stripe's hosted page.
async function createCheckoutSession(req, res, next) {
  try {
    const driver = await Driver.findByIdWithCredentials(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }
    if (!driver.email_verified_at) {
      const err = new Error('Please verify your email address before setting up billing.');
      err.statusCode = 403;
      throw err;
    }

    // Reuse existing Stripe customer or create a new one
    let customerId = driver.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeService.createCustomer(driver);
      customerId = customer.id;
      await Driver.update(driver.id, { stripe_customer_id: customerId });
    }

    const session = await stripeService.createCheckoutSession({
      customerId,
      driverId: driver.id,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
}

// ─── Open Stripe Billing Portal ───────────────────────────────────────────────
// Returns { url } — the frontend redirects to Stripe's hosted portal.
async function billingPortal(req, res, next) {
  try {
    const driver = await Driver.findById(req.driverId);
    if (!driver?.stripe_customer_id) {
      const err = new Error('No billing account found. Please start a subscription first.');
      err.statusCode = 400;
      throw err;
    }

    const session = await stripeService.createPortalSession(
      driver.stripe_customer_id,
      `${APP_URL_ENV}/`,
    );

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
}

function logout(req, res) {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: nodeEnv === 'production' });
  res.json({ ok: true });
}

module.exports = {
  registerDriver,
  loginDriver,
  loginAdmin,
  logout,
  forgotPassword,
  resetDriverPassword,
  verifyEmail,
  resendVerification,
  createCheckoutSession,
  billingPortal,
};
