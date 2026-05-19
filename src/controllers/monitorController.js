'use strict';

// ─── Monitor Controller ───────────────────────────────────────────────────────
// REST handlers + SSE stream for the queue monitor feature.

const Driver  = require('../models/Driver');
const Log     = require('../models/Log');
const monitor = require('../services/monitorService');

// ─── GET /api/admin/monitor/status ───────────────────────────────────────────
// Returns current state snapshot: all watches + last poll stats.
async function getStatus(req, res, next) {
  try {
    res.json(monitor.getState());
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/admin/monitor/stream ───────────────────────────────────────────
// SSE endpoint — streams monitor events to connected admin browsers.
// Each message is: `data: <JSON>\n\n`
function getStream(req, res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  // Send current state immediately so the UI populates without waiting
  const state = monitor.getState();
  res.write(`data: ${JSON.stringify({ type: 'init', payload: state, ts: Date.now() })}\n\n`);

  // Heartbeat every 20s to prevent proxy/load-balancer timeouts
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 20_000);

  const unsubscribe = monitor.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ─── POST /api/admin/monitor/watch ───────────────────────────────────────────
// Body: { vehicleNumber } or { driverId }
// Enables monitoring for a driver and persists monitor_enabled=true to DB.
async function addWatch(req, res, next) {
  try {
    const { driverId: rawId, vehicleNumber } = req.body;

    let driver;
    if (rawId) {
      driver = await Driver.findById(parseInt(rawId, 10));
    } else if (vehicleNumber) {
      driver = await Driver.findByVehicleNumber(String(vehicleNumber).trim());
    }

    if (!driver) {
      const err = new Error('Driver not found'); err.statusCode = 404; throw err;
    }
    if (!driver.is_active) {
      const err = new Error('Driver is inactive'); err.statusCode = 400; throw err;
    }

    // Persist to DB so monitor survives server restarts
    await Driver.update(driver.id, { monitor_enabled: true });

    const state = await monitor.addWatch(driver.id);
    res.json({ message: `Now watching #${driver.vehicle_number}`, state });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/admin/monitor/watch/:driverId ────────────────────────────────
// Remove a driver from the watch list and clear monitor_enabled in DB.
async function removeWatch(req, res, next) {
  try {
    const driverId = parseInt(req.params.driverId, 10);

    const driver = await Driver.findById(driverId);
    if (!driver) { const e = new Error('Driver not found'); e.statusCode = 404; throw e; }

    await Driver.update(driverId, { monitor_enabled: false });
    monitor.removeWatch(driverId);

    res.json({ message: `Stopped watching #${driver.vehicle_number}` });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/admin/monitor/history ──────────────────────────────────────────
// Recent monitor_requeue logs for the events feed.
async function getHistory(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [logs, countResult] = await Promise.all([
      Log.search({ status: req.query.status, limit, offset,
        search: req.query.search }),
      Log.count({ status: req.query.status, search: req.query.search }),
    ]);

    // Filter to monitor_requeue events only — done in JS since Log.search
    // doesn't expose trigger_type yet (avoid a migration for a small filter)
    const monitorLogs = logs.filter(l => l.trigger_type === 'monitor_requeue');

    res.json({
      logs:   monitorLogs,
      total:  parseInt(countResult.count, 10),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, getStream, addWatch, removeWatch, getHistory };
