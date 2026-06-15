'use strict';

// ─── Driver Messages Controller ───────────────────────────────────────────────
// Driver-facing inbox for admin broadcasts. Powers the app's bell badge (unread
// count), the inbox list, and mark-as-read. Every query is scoped to req.driverId
// so a driver only ever sees / mutates their own messages.

const DriverMessageRecipient = require('../models/DriverMessageRecipient');

// GET /api/driver/messages?limit&offset
// Returns the inbox list plus the current unread count (so the client can paint
// the bell badge and the list in a single round-trip).
async function list(req, res, next) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [messages, unread] = await Promise.all([
      DriverMessageRecipient.listForDriver(req.driverId, { limit, offset }),
      DriverMessageRecipient.unreadCount(req.driverId),
    ]);

    res.json({ messages, unread, limit, offset });
  } catch (err) {
    next(err);
  }
}

// GET /api/driver/messages/unread-count — cheap poll for the bell badge.
async function unreadCount(req, res, next) {
  try {
    const unread = await DriverMessageRecipient.unreadCount(req.driverId);
    res.json({ unread });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/messages/:id/read — mark one message read.
async function markRead(req, res, next) {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (!Number.isInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    await DriverMessageRecipient.markRead(req.driverId, messageId);
    const unread = await DriverMessageRecipient.unreadCount(req.driverId);
    res.json({ ok: true, unread });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/messages/read-all — clear the badge.
async function markAllRead(req, res, next) {
  try {
    await DriverMessageRecipient.markAllRead(req.driverId);
    res.json({ ok: true, unread: 0 });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, unreadCount, markRead, markAllRead };
