'use strict';

// ─── Admin Messages Controller ────────────────────────────────────────────────
// Admin endpoints to broadcast a message to drivers (blast or targeted) and to
// review the sent history. Validation lives in the route; delivery logic lives
// in broadcastService — this layer just adapts request → service → response.

const broadcastService = require('../services/broadcastService');
const DriverMessage    = require('../models/DriverMessage');

// POST /api/admin/messages/broadcast
// Body: { title, body, url?, driverIds?: number[], sendSms?: boolean }
//   - driverIds omitted/empty → blast to all active drivers
async function broadcast(req, res, next) {
  try {
    const { title, body, url, driverIds, sendSms } = req.body || {};

    const ids = Array.isArray(driverIds)
      ? driverIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    const result = await broadcastService.broadcast({
      adminId:   req.adminId,
      title,
      body,
      url:       url || null,
      driverIds: ids,
      sendSms:   !!sendSms,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/messages?limit&offset — sent history, newest first.
async function listMessages(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [messages, totalRow] = await Promise.all([
      DriverMessage.listRecent({ limit, offset }),
      DriverMessage.countAll(),
    ]);

    res.json({
      messages,
      total: parseInt(totalRow.count, 10) || 0,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { broadcast, listMessages };
