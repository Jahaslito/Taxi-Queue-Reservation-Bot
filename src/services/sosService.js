'use strict';

// ─── SOS Service ──────────────────────────────────────────────────────────────
//
// Two responsibilities:
//
//   1. In-process pub/sub for SSE: any /api/admin/sos/stream client subscribes
//      here and receives every alert event in real time. Same shape as
//      monitorService's EventEmitter pattern.
//
//   2. Web Push fan-out: on each event, push notifications to every stored
//      admin browser endpoint. Survives closed tabs / minimized browsers
//      (whereas SSE doesn't).
//
// Failure model: Web Push errors are caught per-endpoint. A 404/410 (browser
// revoked the subscription) prunes the row from the DB. Everything else is
// logged but doesn't fail the calling request — the driver's alert must land
// regardless of whether admin notifications succeed.

const { EventEmitter } = require('events');
const webpush          = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@sanqueue.com';

let pushConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushConfigured = true;
  } catch (err) {
    console.warn('[SOS] Invalid VAPID keys — Web Push disabled:', err.message);
  }
} else {
  console.warn('[SOS] VAPID keys not set — Web Push disabled. SSE will still work.');
}

const bus = new EventEmitter();
bus.setMaxListeners(500); // mirrors monitorService cap

/** Subscribe an SSE client. Returns an unsubscribe function. */
function subscribe(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/**
 * Broadcast an event to all SSE subscribers and (best-effort) all stored
 * Web Push endpoints. Caller-supplied payload should be plain-JSON-serialisable.
 *
 * Push fan-out runs in the background — the caller is not awaited on it.
 */
function emit(event) {
  bus.emit('event', event);

  // Only push for new alerts and status changes — not every location ping.
  if (event?.type === 'sos.new' || event?.type === 'sos.updated') {
    sendPush(event).catch((err) => {
      console.warn('[SOS] Push fan-out failed:', err.message);
    });
  }
}

async function sendPush(event) {
  if (!pushConfigured) return;

  let subs;
  try {
    subs = await PushSubscription.findAllByRole('admin');
  } catch (err) {
    console.warn('[SOS] Could not load push subscriptions:', err.message);
    return;
  }
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: event.type === 'sos.new' ? '🚨 SOS Alert' : 'SOS Update',
    body:  buildPushBody(event),
    tag:   `sos-${event.payload?.id ?? 'unknown'}`,
    data:  {
      url:     '/admin#sos',
      alertId: event.payload?.id ?? null,
      type:    event.type,
    },
  });

  await Promise.all(subs.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh_key, auth: s.auth_key },
    };
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 });
      // best-effort touch — don't await
      PushSubscription.touch(s.endpoint).catch(() => {});
    } catch (err) {
      // 404 / 410 = subscription revoked by browser. Prune so we stop retrying.
      if (err.statusCode === 404 || err.statusCode === 410) {
        PushSubscription.deleteByEndpoint(s.endpoint).catch(() => {});
      } else {
        console.warn(`[SOS] Push to ${s.endpoint.slice(-30)} failed:`, err.statusCode || err.message);
      }
    }
  }));
}

function buildPushBody(event) {
  const p = event.payload || {};
  const driver = p.driver_name || `Driver #${p.driver_id ?? '?'}`;
  const vehicle = p.driver_vehicle_number ? ` (#${p.driver_vehicle_number})` : '';

  if (event.type === 'sos.new') {
    return `${driver}${vehicle} has triggered an SOS. Open the admin panel now.`;
  }
  if (p.status === 'acknowledged') return `${driver}${vehicle} — alert acknowledged`;
  if (p.status === 'resolved')     return `${driver}${vehicle} — alert resolved`;
  return `${driver}${vehicle} — status: ${p.status}`;
}

function isPushConfigured() {
  return pushConfigured;
}

function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

module.exports = {
  subscribe,
  emit,
  isPushConfigured,
  getVapidPublicKey,
};
