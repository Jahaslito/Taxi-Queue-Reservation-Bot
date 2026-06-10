'use strict';

// ─── Driver Push Notification Controller ──────────────────────────────────────
//
// Lets the driver-app PWA register/unregister a Web Push subscription for
// dispatch alerts. Mirrors the admin SOS push endpoints in sosController, but
// keyed by driverId instead of adminId.
//
// Flow:
//   1. Driver app calls GET /api/driver/push/config to learn the VAPID public
//      key + whether push is enabled server-side.
//   2. Driver app prompts for Notification permission, registers the service
//      worker, and creates a subscription with the VAPID key.
//   3. POSTs the resulting endpoint + keys to /api/driver/push/subscribe.
//   4. On logout / "disable alerts", POSTs the endpoint to
//      /api/driver/push/unsubscribe.

const PushSubscription = require('../models/PushSubscription');
const dispatchNotify   = require('../services/dispatchNotificationService');

// GET /api/driver/push/config
// Returns the VAPID public key so the browser can create a push subscription.
function config(req, res) {
  res.json({
    enabled:   dispatchNotify.isPushConfigured(),
    publicKey: dispatchNotify.getVapidPublicKey(),
  });
}

// POST /api/driver/push/subscribe
// Body: { endpoint, keys: { p256dh, auth } }
async function subscribe(req, res, next) {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint, keys.p256dh, keys.auth required' });
    }

    await PushSubscription.upsert({
      role:         'driver',
      subscriberId: req.driverId,
      endpoint,
      p256dhKey:    keys.p256dh,
      authKey:      keys.auth,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/push/unsubscribe
// Body: { endpoint }
async function unsubscribe(req, res, next) {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    await PushSubscription.deleteByEndpoint(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { config, subscribe, unsubscribe };
