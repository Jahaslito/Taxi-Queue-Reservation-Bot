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

// 'lax' lets the JWT cookie ride along on top-level navigations from external
// sites (e.g. when Stripe Checkout redirects back to /?billing=success).
// 'strict' would block the cookie on that redirect, sending the user to the
// login screen and breaking the post-checkout flow.
// CSRF protection is still preserved — 'lax' blocks cross-site embedded
// contexts (iframes, image tags, etc.).
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure:   nodeEnv === 'production',
};

// ─── Public SAN credential check (used by the registration form) ──────────────
// Lets a prospective driver test their SAN eDispatch username/password before
// signing up. Unauthenticated but rate-limited (loginLimiter on the route) and
// it performs the same login-only round-trip the bot uses. No driverId, so it
// only classifies — it never touches the per-driver lockout breaker.
async function verifySanCredentials(req, res, next) {
  try {
    const { sanUsername, sanPassword, vehicleNumber } = req.body;
    const { verifyCredentials } = require('../services/botService');
    const check = await verifyCredentials({
      sanUsername:   String(sanUsername).trim(),
      sanPassword:   String(sanPassword),
      vehicleNumber: vehicleNumber ? String(vehicleNumber).trim() : undefined,
    });
    const message = check.verified === true
      ? 'SAN eDispatch login confirmed — these credentials work.'
      : check.verified === false
        ? 'SAN eDispatch rejected this username or password.'
        : "Couldn't reach SAN eDispatch to verify — please try again in a moment.";
    res.json({ ...check, message });
  } catch (err) {
    next(err);
  }
}

async function registerDriver(req, res, next) {
  try {
    const { name, phone, appPassword, sanUsername, sanPassword, vehicleNumber, scheduledTime, scheduledDays, daySchedules } = req.body;
    const email = req.body.email ? req.body.email.toLowerCase().trim() : null;

    if (email) {
      const existing = await Driver.findByEmail(email);
      if (existing) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }
    }

    const existingVehicle = await Driver.findByVehicleNumber(vehicleNumber);
    if (existingVehicle) {
      const err = new Error('Vehicle number already registered');
      err.statusCode = 409;
      throw err;
    }

    // Authoritative SAN credential check — the client gates the Register button
    // on this same test, but never trust the client. A confirmed rejection
    // blocks signup (no point creating an account the bot can never log into);
    // an unreachable SAN does NOT block (don't strand a real driver over our own
    // connectivity blip — they can fix/verify later from the dashboard).
    try {
      const { verifyCredentials } = require('../services/botService');
      const check = await verifyCredentials({ sanUsername, sanPassword, vehicleNumber });
      if (check.verified === false) {
        const err = new Error('SAN eDispatch rejected these credentials — check your username and password.');
        err.statusCode = 400;
        throw err;
      }
    } catch (err) {
      if (err.statusCode) throw err; // our 400 above — propagate
      console.warn('[Auth] SAN verify could not run during registration:', err.message); // unreachable → allow
    }

    // Schedule fields are configured after registration via the dashboard
    // (drivers pick time-based OR position-based mode). Only build a
    // day_schedules payload here if the caller actually supplied one — we
    // explicitly do NOT default to "all days at 05:00" because that turned
    // into a real bug: drivers who later set up a position schedule could
    // still get auto-checked-in at 5 AM if the time fields weren't cleared
    // by a subsequent edit.
    let daySchedulesJson = null;
    if (daySchedules) {
      daySchedulesJson = daySchedules; // already a JSON string from frontend
    } else if (scheduledTime) {
      const activeDays = (scheduledDays || '0,1,2,3,4,5,6').split(',').map(String);
      const ds = {};
      for (let d = 0; d < 7; d++) {
        ds[String(d)] = activeDays.includes(String(d)) ? scheduledTime : null;
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
      scheduled_time:                 scheduledTime || null,
      scheduled_days:                 scheduledTime ? (scheduledDays || '0,1,2,3,4,5,6') : null,
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
    const { vehicleNumber, appPassword } = req.body;
    const email = req.body.email ? req.body.email.toLowerCase().trim() : null;

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

    // Refuse to issue a token for an inactive account. The credentials WERE
    // valid (so 401 would be misleading), but the account is not authorized
    // to use the app. 403 + accountInactive flag lets the client render a
    // dedicated "contact admin" screen instead of looping back to login.
    if (!driver.is_active) {
      console.log(`[Auth] Login blocked — driver ${driver.id} (#${driver.vehicle_number}) is inactive`);
      return res.status(403).json({
        error: 'Your account is inactive. Please contact the admin to reactivate it.',
        accountInactive: true,
      });
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
    const email = req.body.email ? req.body.email.toLowerCase().trim() : '';
    const driver = await Driver.findByEmail(email);

    // Always return the same response — protects against email enumeration
    // by attackers and avoids hinting that a deactivated account exists.
    const genericOk = { message: 'If that email is registered, you will receive a reset link shortly.' };

    if (!driver) return res.json(genericOk);

    // Skip the reset email for inactive drivers — the reset path can't help
    // them, and sending a "click to reset" link gives them false hope that
    // they'll be able to log in afterwards. Admin sees it in logs so they
    // can reach out if the deactivation was a mistake.
    if (!driver.is_active) {
      console.log(`[Auth] forgotPassword: skipped reset email for inactive driver ${driver.id} (#${driver.vehicle_number})`);
      return res.json(genericOk);
    }

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

    // Honest post-reset message: if the account is still inactive (e.g., admin
    // pre-staged a deactivation and the reset link was generated before),
    // tell the driver they need to contact the admin instead of luring them
    // back to a login screen that will only show the inactive page again.
    if (!driver.is_active) {
      return res.json({
        message: 'Password updated. Please contact the admin to reactivate your account before logging in.',
        accountInactive: true,
      });
    }
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

  // Different post-verify state for inactive drivers — the client renders a
  // "verified, but account is inactive" message instead of the celebratory
  // success state that implies they can now use the app.
  const verifiedState = driver.is_active ? 'success' : 'inactive';
  res.redirect(`${APP_URL}/?verified=${verifiedState}`);
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
    const driver = await Driver.findByIdWithCredentials(req.driverId);
    if (!driver) {
      const err = new Error('Driver not found');
      err.statusCode = 404;
      throw err;
    }

    // Grandfathered drivers (migrated from pre-billing era) have
    // subscription_status='active' but no Stripe customer record. Redirect
    // them through Checkout instead of erroring — this creates the customer
    // on first click and self-heals the account.
    if (!driver.stripe_customer_id) {
      if (!driver.email_verified_at) {
        const err = new Error('Please verify your email address before setting up billing.');
        err.statusCode = 403;
        throw err;
      }
      const customer = await stripeService.createCustomer(driver);
      await Driver.update(driver.id, { stripe_customer_id: customer.id });
      const checkout = await stripeService.createCheckoutSession({
        customerId: customer.id,
        driverId:   driver.id,
      });
      return res.json({ url: checkout.url });
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
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: nodeEnv === 'production' });
  res.json({ ok: true });
}

module.exports = {
  registerDriver,
  verifySanCredentials,
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
