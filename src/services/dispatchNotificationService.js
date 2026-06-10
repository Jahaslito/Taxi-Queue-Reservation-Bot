'use strict';

// ─── Dispatch Notification Service ────────────────────────────────────────────
//
// Fans out a "you're dispatched" notification when the monitor first observes
// a driver on a T1/T2 terminal page. Two channels:
//
//   • SMS via Telnyx (smsService.js) — the durable channel. Goes to the
//     driver's phone, no app required.
//   • Web Push via web-push  — the in-app channel. Lands on every device the
//     driver has subscribed (driver-app PWA installs). Notification body
//     includes a static 25-minute "be there by HH:MM PT" target.
//
// Both channels are best-effort. SMS failure does not block push, push failure
// does not block SMS, and a fully-unconfigured environment is a no-op (so dev
// boxes don't need Telnyx + VAPID to work).
//
// Dedupe: the monitor calls notifyDispatch at the moment !state.terminalSeen
// flips to true. A second call for the same driver+terminal+day is silently
// suppressed — defends against double-fire if the poll loop is racing.

const webpush          = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const smsService       = require('./smsService');

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@sanqueue.com';

let pushConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    // sosService already calls setVapidDetails — calling again with the same
    // values is a no-op and avoids ordering bugs if this module is required
    // before sos.
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushConfigured = true;
  } catch (err) {
    console.warn('[Dispatch] Invalid VAPID keys — driver push disabled:', err.message);
  }
}

// Minutes between dispatch and when the driver should be at the terminal.
// 25 was the user's ask; bumping this is a pure config change.
const ETA_MINUTES = 25;

// Per-process dedupe set, keyed by `${driverId}:${dayKey}`. The dispatch
// notification fires at the waiting → dispatched transition, which can only
// happen once per driver per day in practice (driver can't be redispatched
// the same day without first finishing a trip + being requeued, which is a
// new state transition). In-memory by design — a restart resets dedupe, but
// the monitor's own `prev !== 'dispatched'` gate also resets, and the only
// way to re-fire is for the driver to leave the dispatched section and come
// back, which itself is a fresh dispatch event worth notifying.
const sentKeys = new Set();

function dedupeKey(driverId, dayKey) {
  return `${driverId}:${dayKey}`;
}

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function formatEtaPT(now = new Date()) {
  const eta = new Date(now.getTime() + ETA_MINUTES * 60 * 1000);
  return eta.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  });
}

function buildSmsBody({ driverName, vehicleNumber, terminal, etaText }) {
  // Keep inside one SMS segment (160 chars GSM-7) to avoid multi-part
  // billing. Terminal is required — the monitor never calls notifyDispatch
  // without one (an unknown terminal isn't actionable, so the monitor waits
  // for SAN to fill DEST on a subsequent poll).
  return `${driverName}, cab #${vehicleNumber}: dispatched to ${terminal}. ` +
         `Be there by ${etaText} PT.`;
}

function buildPushPayload({ driverName, vehicleNumber, terminal, etaText }) {
  return JSON.stringify({
    title: `🚖 Dispatched to ${terminal}`,
    body:  `${driverName} (#${vehicleNumber}) — be at ${terminal} by ${etaText} PT.`,
    // 'tag' replaces any prior dispatch notification on the device so the
    // driver doesn't see a stack of stale ones from earlier trips.
    tag:   `dispatch-${vehicleNumber}`,
    data: {
      type:           'dispatch',
      url:            '/',
      driverName,
      vehicleNumber,
      terminal,
      etaText,
      etaMinutes:     ETA_MINUTES,
      dispatchedAt:   Date.now(),
    },
  });
}

async function sendPushFanout(driverId, payloadJson) {
  if (!pushConfigured) return { attempted: 0, ok: 0 };

  let subs;
  try {
    subs = await PushSubscription.findAllByRole('driver');
  } catch (err) {
    console.warn('[Dispatch] Could not load driver push subscriptions:', err.message);
    return { attempted: 0, ok: 0 };
  }

  // Filter to this driver's own subscriptions. We don't want to broadcast a
  // dispatch notification to every driver — only the one who got dispatched.
  const mine = subs.filter((s) => s.subscriber_id === driverId);
  if (!mine.length) return { attempted: 0, ok: 0 };

  let ok = 0;
  await Promise.all(mine.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh_key, auth: s.auth_key },
    };
    try {
      await webpush.sendNotification(subscription, payloadJson, { TTL: 60 });
      ok++;
      PushSubscription.touch(s.endpoint).catch(() => {});
    } catch (err) {
      // 404 / 410 = browser revoked the subscription — drop it so we stop trying.
      if (err.statusCode === 404 || err.statusCode === 410) {
        PushSubscription.deleteByEndpoint(s.endpoint).catch(() => {});
      } else {
        console.warn(`[Dispatch] Push to ${s.endpoint.slice(-30)} failed:`, err.statusCode || err.message);
      }
    }
  }));
  return { attempted: mine.length, ok };
}

/**
 * Notify a driver that they've been dispatched to a known terminal.
 *
 * Triggered by the monitor while the driver is in 'dispatched' state and
 * V Holding's DEST column has been populated. A null terminal is treated
 * as not-ready-to-notify — the monitor keeps polling and retries on the
 * next tick.
 *
 * @param {object} args
 * @param {number} args.driverId
 * @param {string} args.driverName
 * @param {string} args.vehicleNumber  Cab number, e.g. "0187"
 * @param {string|null} args.phone     E.164, e.g. "+16195551234"; null → skip SMS
 * @param {'T1'|'T2'} args.terminal    Required — from V Holding DEST column
 * @param {Date} [args.now]            For deterministic testing
 * @returns {Promise<{ smsSent: boolean, pushSent: number, deduped: boolean, skipped?: 'no_terminal'|'no_driver' }>}
 */
async function notifyDispatch({ driverId, driverName, vehicleNumber, phone, terminal, now }) {
  if (!driverId) {
    return { smsSent: false, pushSent: 0, deduped: false, skipped: 'no_driver' };
  }
  if (!terminal) {
    // Belt-and-suspenders: the monitor gates this caller on terminal known,
    // but if a future call site forgets to check, we still refuse to send a
    // notification without an actionable terminal.
    return { smsSent: false, pushSent: 0, deduped: false, skipped: 'no_terminal' };
  }

  const key = dedupeKey(driverId, todayPT());
  if (sentKeys.has(key)) {
    return { smsSent: false, pushSent: 0, deduped: true };
  }
  // Mark sent BEFORE awaiting so a racing second call doesn't double-fire.
  sentKeys.add(key);

  const etaText = formatEtaPT(now);
  const ctx     = { driverName, vehicleNumber, terminal, etaText };

  let smsSent  = false;
  let pushSent = 0;

  // Run SMS and push in parallel — they're independent.
  const [smsResult, pushResult] = await Promise.allSettled([
    phone ? smsService.sendSms(phone, buildSmsBody(ctx)) : Promise.resolve({ ok: false, reason: 'no_phone' }),
    sendPushFanout(driverId, buildPushPayload(ctx)),
  ]);

  if (smsResult.status === 'fulfilled' && smsResult.value?.ok)  smsSent  = true;
  if (pushResult.status === 'fulfilled')                          pushSent = pushResult.value.ok;

  console.log(
    `[Dispatch] #${vehicleNumber} → dispatched notify ` +
    `(sms=${smsSent ? 'ok' : 'skip'}, push=${pushSent}, eta=${etaText} PT, term=${terminal ?? 'unknown'})`,
  );

  return { smsSent, pushSent, deduped: false };
}

module.exports = {
  notifyDispatch,
  isPushConfigured: () => pushConfigured,
  getVapidPublicKey: () => VAPID_PUBLIC_KEY,
  ETA_MINUTES,
  // Test-only helpers — let the test suite reset module-level state between
  // describe blocks without juggling jest.resetModules().
  _clearDedupeForTest: () => { sentKeys.clear(); },
  _setPushConfiguredForTest: (v) => { pushConfigured = !!v; },
  _formatEtaPT: formatEtaPT,
  _buildSmsBody: buildSmsBody,
  _buildPushPayload: buildPushPayload,
};
