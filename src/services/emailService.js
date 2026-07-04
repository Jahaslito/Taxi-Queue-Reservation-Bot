// ─── Email Service ────────────────────────────────────────────────────────────
// Sends transactional emails via Resend.
// In development (no RESEND_API_KEY), logs the email to the console instead.

const { Resend }  = require('resend');
const { nodeEnv } = require('../config/env');

const resend    = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM      = process.env.EMAIL_FROM || 'SAN Queue <noreply@sanqueue.com>';
const APP_URL   = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// ─── Shared layout wrapper ────────────────────────────────────────────────────
function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #060c1a; font-family: 'Segoe UI', system-ui, sans-serif; }
    .wrap { max-width: 520px; margin: 40px auto; background: #0d1628; border: 1px solid rgba(255,255,255,0.07); border-radius: 20px; overflow: hidden; }
    .top-bar { height: 4px; background: linear-gradient(90deg, #00b4ff, #7c6dff); }
    .inner { padding: 40px 36px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
    .logo-dot { width: 10px; height: 10px; border-radius: 50%; background: #00b4ff; }
    .logo-text { font-size: 18px; font-weight: 800; color: rgba(255,255,255,0.65); letter-spacing: 2px; text-transform: uppercase; }
    .logo-text span { color: #00b4ff; }
    h1 { font-size: 24px; font-weight: 800; color: #fff; margin: 0 0 12px; line-height: 1.2; }
    p  { font-size: 15px; color: rgba(255,255,255,0.55); line-height: 1.7; margin: 0 0 20px; }
    .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #00b4ff, #7c6dff); color: #fff !important; font-weight: 700; font-size: 15px; text-decoration: none; border-radius: 12px; margin: 8px 0 24px; }
    .link-fallback { font-size: 12px; color: rgba(255,255,255,0.3); word-break: break-all; }
    .link-fallback a { color: rgba(255,255,255,0.45); }
    .divider { border: none; border-top: 1px solid rgba(255,255,255,0.07); margin: 24px 0; }
    .footer { font-size: 12px; color: rgba(255,255,255,0.25); line-height: 1.6; }
    .warning { background: rgba(240,90,91,0.1); border: 1px solid rgba(240,90,91,0.3); border-radius: 10px; padding: 12px 16px; font-size: 13px; color: rgba(255,120,120,0.9); margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top-bar"></div>
    <div class="inner">
      <div class="logo">
        <div class="logo-dot"></div>
        <div class="logo-text">SAN <span>Queue</span></div>
      </div>
      ${bodyHtml}
      <hr class="divider" />
      <div class="footer">
        You're receiving this because you have a SAN Queue driver account.<br />
        If you didn't request this, you can safely ignore it.
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ─── Template: email verification ────────────────────────────────────────────
function verificationEmail(driverName, verifyUrl) {
  return layout('Verify your email — SAN Queue', `
    <h1>Verify your email address</h1>
    <p>Hi ${driverName}, thanks for registering with SAN Queue. Click the button below to confirm your email address.</p>
    <a class="btn" href="${verifyUrl}">Verify Email</a>
    <p>This link expires in <strong style="color:#fff;">24 hours</strong>.</p>
    <div class="link-fallback">
      If the button doesn't work, copy this link into your browser:<br />
      <a href="${verifyUrl}">${verifyUrl}</a>
    </div>
  `);
}

// ─── Template: password reset ─────────────────────────────────────────────────
function passwordResetEmail(driverName, resetUrl) {
  return layout('Reset your password — SAN Queue', `
    <h1>Reset your password</h1>
    <p>Hi ${driverName}, we received a request to reset your SAN Queue app password. Click the button below to choose a new one.</p>
    <a class="btn" href="${resetUrl}">Reset Password</a>
    <p>This link expires in <strong style="color:#fff;">1 hour</strong>.</p>
    <div class="warning">⚠️ If you didn't request a password reset, ignore this email. Your password will not change.</div>
    <div class="link-fallback">
      If the button doesn't work, copy this link into your browser:<br />
      <a href="${resetUrl}">${resetUrl}</a>
    </div>
  `);
}

// ─── Template: payment failed ──────────────────────────────────────────────────
function paymentFailedEmail(driverName, billingUrl) {
  return layout('Payment failed — action needed — SAN Queue', `
    <h1>Your payment didn't go through</h1>
    <p>Hi ${driverName}, we couldn't charge your card for your SAN Queue subscription, so your account has been paused — the bot will stop checking you into the queue until this is resolved.</p>
    <div class="warning">⚠️ Your account is locked until a working card is added. Add your card below and you'll be charged right away to restore access.</div>
    <a class="btn" href="${billingUrl}">Add Card &amp; Restore Access</a>
    <div class="link-fallback">
      If the button doesn't work, copy this link into your browser:<br />
      <a href="${billingUrl}">${billingUrl}</a>
    </div>
  `);
}

// ─── Send helper ─────────────────────────────────────────────────────────────
async function send({ to, subject, html }) {
  if (!resend) {
    // Dev fallback — print to console so you can test without a real API key
    console.log('\n─── [EmailService] DEV MODE — email not sent ───');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body snippet: ${html.slice(0, 200).replace(/\s+/g, ' ')}…`);
    console.log('────────────────────────────────────────────────\n');
    return { id: 'dev-mock' };
  }

  const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(`Email send failed: ${error.message}`);
  return data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send email verification link to a newly registered (or requesting) driver.
 */
async function sendVerificationEmail(driver, token) {
  const verifyUrl = `${APP_URL}/api/auth/driver/verify-email?token=${token}`;
  await send({
    to:      driver.email,
    subject: 'Verify your SAN Queue email address',
    html:    verificationEmail(driver.name, verifyUrl),
  });
}

/**
 * Send password reset link.
 */
async function sendPasswordResetEmail(driver, token) {
  const resetUrl = `${APP_URL}/?reset=${token}`;
  await send({
    to:      driver.email,
    subject: 'Reset your SAN Queue password',
    html:    passwordResetEmail(driver.name, resetUrl),
  });
}

/**
 * Notify a driver that their subscription payment failed and their account is
 * locked until they add a working card. CTA lands on the in-app billing screen.
 */
async function sendPaymentFailedEmail(driver) {
  const billingUrl = `${APP_URL}/app/`;
  await send({
    to:      driver.email,
    subject: 'Payment failed — your SAN Queue account is paused',
    html:    paymentFailedEmail(driver.name, billingUrl),
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendPaymentFailedEmail, APP_URL };
