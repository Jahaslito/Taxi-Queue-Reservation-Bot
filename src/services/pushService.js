'use strict';

// ─── Push Service — shared Web Push sender ────────────────────────────────────
//
// Low-level fan-out over a set of push subscriptions. Centralizes VAPID config
// and the send/prune loop so every notification feature (dispatch, SOS, admin
// broadcasts, …) shares one battle-tested path instead of re-implementing it.
//
// VAPID details are process-global once set — web-push.setVapidDetails is
// idempotent across modules, so it's safe that the older dispatch/SOS services
// also call it. New features should depend on THIS module.
//
// Failure model: best-effort. A fully-unconfigured environment (no VAPID keys)
// is a no-op so dev boxes work without secrets. Dead endpoints (404/410) are
// surfaced via the onStale callback so the caller can prune its own storage.

const webpush = require('web-push');

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@sanqueue.com';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.warn('[Push] Invalid VAPID keys — web push disabled:', err.message);
  }
}

function isConfigured() { return configured; }
function getPublicKey() { return VAPID_PUBLIC_KEY; }

/**
 * Send one payload to many subscriptions in parallel.
 *
 * @param {Array<{endpoint:string,p256dh_key:string,auth_key:string}>} subscriptions
 *        Rows in the push_subscriptions shape (snake_case keys).
 * @param {string} payloadJson  Pre-serialized JSON payload.
 * @param {object} [opts]
 * @param {number} [opts.ttl=60]            Web Push TTL (seconds).
 * @param {(endpoint:string)=>void} [opts.onStale]
 *        Called once per endpoint that returns 404/410 (revoked) so the caller
 *        can delete it. Never awaited — pruning is fire-and-forget.
 * @returns {Promise<{targeted:number, delivered:number, failed:number}>}
 */
async function sendToSubscriptions(subscriptions, payloadJson, { ttl = 60, onStale } = {}) {
  const targeted = subscriptions?.length || 0;
  if (!configured || !targeted) {
    return { targeted, delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed    = 0;

  await Promise.all(subscriptions.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh_key, auth: s.auth_key },
    };
    try {
      await webpush.sendNotification(subscription, payloadJson, { TTL: ttl });
      delivered++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        if (onStale) onStale(s.endpoint);
      } else {
        console.warn(`[Push] send to …${String(s.endpoint).slice(-24)} failed:`, err.statusCode || err.message);
      }
    }
  }));

  return { targeted, delivered, failed };
}

module.exports = {
  isConfigured,
  getPublicKey,
  sendToSubscriptions,
  VAPID_SUBJECT,
};
