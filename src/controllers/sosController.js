'use strict';

// ─── SOS Controller ───────────────────────────────────────────────────────────
// Driver endpoints: fire an SOS, push location updates, cancel.
// Admin endpoints: list, SSE stream, acknowledge, resolve, Web Push setup.
//
// Reliability note: the driver "create" endpoint intentionally accepts a null
// lat/lng. Geolocation can take 5–30 s on first use, and we never want the
// alert to be blocked on it. The client fires the alert with no coords, then
// patches them in via the location endpoint as soon as they arrive.

const SosAlert         = require('../models/SosAlert');
const PushSubscription = require('../models/PushSubscription');
const Driver           = require('../models/Driver');
const sos              = require('../services/sosService');
const { reverseGeocode } = require('../services/geocodingService');

// Fire-and-forget reverse geocode for an alert's latest coords. Updates
// place_name and emits sos.updated when a fresh name lands. Safe to call on
// every location ping — the geocoder caches at ~11m precision so repeated
// pings at the same intersection cost zero network.
async function kickoffGeocode(alertId, lat, lng) {
  if (lat == null || lng == null) return;
  try {
    const name = await reverseGeocode(lat, lng);
    if (!name) return;

    const current = await SosAlert.findById(alertId);
    if (!current) return;                          // alert deleted mid-flight
    if (current.place_name === name) return;       // no change — skip emit

    const enriched = await SosAlert.setPlaceName(alertId, name);
    sos.emit({ type: 'sos.updated', payload: enriched, ts: Date.now() });
  } catch (err) {
    console.warn('[SOS] Geocode update failed:', err.message);
  }
}

// ─── shared helpers ──────────────────────────────────────────────────────────
function parseLatLng(body) {
  const lat = body.lat != null ? Number(body.lat) : null;
  const lng = body.lng != null ? Number(body.lng) : null;
  const acc = body.accuracy != null ? Number(body.accuracy) : null;
  if (lat != null && (!Number.isFinite(lat) || lat < -90  || lat > 90))  return { error: 'Invalid lat' };
  if (lng != null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return { error: 'Invalid lng' };
  if (acc != null && (!Number.isFinite(acc) || acc < 0)) return { error: 'Invalid accuracy' };
  return { lat, lng, accuracy: acc };
}

// ─── Driver: POST /api/driver/sos ────────────────────────────────────────────
// Body: { lat?, lng?, accuracy?, message?, liveTracking? }
// Returns: { alert } — id used by the client for subsequent location updates.
async function create(req, res, next) {
  try {
    // Dedupe: if this driver already has an open alert, return it instead of
    // creating a second. Saves the admin from "is this the same emergency?" UX.
    const existing = await SosAlert.findOpenForDriver(req.driverId);
    if (existing) {
      return res.status(200).json({ alert: existing, deduped: true });
    }

    const parsed = parseLatLng(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const alert = await SosAlert.create({
      driverId:     req.driverId,
      lat:          parsed.lat,
      lng:          parsed.lng,
      accuracy:     parsed.accuracy,
      message:      typeof req.body.message === 'string' ? req.body.message.slice(0, 500) : null,
      liveTracking: Boolean(req.body.liveTracking),
    });

    const driver = await Driver.findById(req.driverId);
    const payload = {
      ...alert,
      driver_name:           driver?.name,
      driver_phone:          driver?.phone,
      driver_email:          driver?.email,
      driver_vehicle_number: driver?.vehicle_number,
    };

    sos.emit({ type: 'sos.new', payload, ts: Date.now() });
    res.status(201).json({ alert });

    // Don't block the response on the geocode call — the alert must be in
    // admins' hands within milliseconds. Address resolves a beat later.
    kickoffGeocode(alert.id, parsed.lat, parsed.lng);
  } catch (err) {
    next(err);
  }
}

// ─── Driver: POST /api/driver/sos/:id/location ───────────────────────────────
// Body: { lat, lng, accuracy? }
async function pushLocation(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const alert = await SosAlert.findById(id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.driver_id !== req.driverId) return res.status(403).json({ error: 'Forbidden' });
    if (alert.status === SosAlert.STATUS.RESOLVED) return res.status(409).json({ error: 'Alert is already resolved' });

    const parsed = parseLatLng(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.lat == null || parsed.lng == null) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const updated = await SosAlert.appendLocation(id, parsed);
    sos.emit({ type: 'sos.location', payload: updated, ts: Date.now() });

    res.json({ alert: updated });

    kickoffGeocode(id, parsed.lat, parsed.lng);
  } catch (err) {
    next(err);
  }
}

// ─── Driver: POST /api/driver/sos/:id/live-tracking ──────────────────────────
async function setLiveTracking(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const alert = await SosAlert.findById(id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.driver_id !== req.driverId) return res.status(403).json({ error: 'Forbidden' });
    if (alert.status === SosAlert.STATUS.RESOLVED) return res.status(409).json({ error: 'Alert is already resolved' });

    const updated = await SosAlert.setLiveTracking(id, Boolean(req.body.enabled));
    sos.emit({ type: 'sos.updated', payload: updated, ts: Date.now() });
    res.json({ alert: updated });
  } catch (err) {
    next(err);
  }
}

// ─── Driver: POST /api/driver/sos/:id/cancel ─────────────────────────────────
async function cancel(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const alert = await SosAlert.cancelByDriver(id, req.driverId);
    if (!alert) return res.status(409).json({ error: 'Alert not found, already resolved, or not yours' });

    sos.emit({ type: 'sos.updated', payload: alert, ts: Date.now() });
    res.json({ alert });
  } catch (err) {
    next(err);
  }
}

// ─── Driver: GET /api/driver/sos/open ────────────────────────────────────────
// On app boot, the driver UI calls this to re-attach to any in-flight alert
// (e.g. after a tab reload during an active emergency).
async function getOpenForDriver(req, res, next) {
  try {
    const alert = await SosAlert.findOpenForDriver(req.driverId);
    res.json({ alert: alert || null });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: GET /api/admin/sos ───────────────────────────────────────────────
async function adminList(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status;

    const [alerts, openCount] = await Promise.all([
      SosAlert.listRecent({ limit, offset, status }),
      SosAlert.countOpen(),
    ]);

    res.json({
      alerts,
      openCount: parseInt(openCount.count, 10),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: GET /api/admin/sos/:id ───────────────────────────────────────────
async function adminGet(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [alert, history] = await Promise.all([
      SosAlert.findByIdWithDriver(id),
      SosAlert.getLocationHistory(id),
    ]);

    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert, history });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: GET /api/admin/sos/stream ────────────────────────────────────────
// Same pattern as monitorController.getStream.
function adminStream(req, res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'sos.hello', ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  const unsubscribe = sos.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ─── Admin: POST /api/admin/sos/:id/acknowledge ──────────────────────────────
async function adminAcknowledge(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const updated = await SosAlert.acknowledge(id, req.adminId);
    if (!updated) {
      // Already acknowledged or resolved — return the current state so the UI re-renders.
      const current = await SosAlert.findByIdWithDriver(id);
      return res.status(409).json({ error: 'Alert is no longer active', alert: current });
    }

    const enriched = await SosAlert.findByIdWithDriver(id);
    sos.emit({ type: 'sos.updated', payload: enriched, ts: Date.now() });
    res.json({ alert: enriched });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: POST /api/admin/sos/:id/resolve ──────────────────────────────────
async function adminResolve(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const updated = await SosAlert.resolve(id, req.adminId);
    if (!updated) {
      const current = await SosAlert.findByIdWithDriver(id);
      return res.status(409).json({ error: 'Alert is already resolved', alert: current });
    }

    const enriched = await SosAlert.findByIdWithDriver(id);
    sos.emit({ type: 'sos.updated', payload: enriched, ts: Date.now() });
    res.json({ alert: enriched });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: GET /api/admin/sos/push/config ───────────────────────────────────
// Returns the VAPID public key so the admin browser can register for push.
function adminPushConfig(req, res) {
  res.json({
    enabled:   sos.isPushConfigured(),
    publicKey: sos.getVapidPublicKey(),
  });
}

// ─── Admin: POST /api/admin/sos/push/subscribe ───────────────────────────────
// Body: { endpoint, keys: { p256dh, auth } }
async function adminPushSubscribe(req, res, next) {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint, keys.p256dh, keys.auth required' });
    }

    await PushSubscription.upsert({
      role:         'admin',
      subscriberId: req.adminId,
      endpoint,
      p256dhKey:    keys.p256dh,
      authKey:      keys.auth,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: POST /api/admin/sos/push/unsubscribe ─────────────────────────────
async function adminPushUnsubscribe(req, res, next) {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    await PushSubscription.deleteByEndpoint(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  // driver
  create,
  pushLocation,
  setLiveTracking,
  cancel,
  getOpenForDriver,
  // admin
  adminList,
  adminGet,
  adminStream,
  adminAcknowledge,
  adminResolve,
  adminPushConfig,
  adminPushSubscribe,
  adminPushUnsubscribe,
};
