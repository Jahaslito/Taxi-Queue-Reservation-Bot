'use strict';

// ─── Broadcast Service ────────────────────────────────────────────────────────
//
// Admin → drivers messaging. Sends an admin-authored message to all active
// drivers (a "blast") or a selected subset ("targeted"), across three surfaces:
//
//   • In-app inbox  — persisted recipient rows (always; the source of truth).
//   • Web Push      — OS notification for drivers who enabled it (best-effort).
//   • SMS via Telnyx — optional per-broadcast, the only channel that reaches
//                      drivers who never enabled push (best-effort).
//
// Order matters: we persist the message + recipients FIRST, then fan out. If
// push/SMS partially fail, the driver still has the message waiting in their
// bell inbox.

const Driver           = require('../models/Driver');
const DriverMessage    = require('../models/DriverMessage');
const PushSubscription = require('../models/PushSubscription');
const pushService      = require('./pushService');
const smsService       = require('./smsService');

const MAX_TITLE = 100;
const MAX_BODY  = 1000;

// Admin-message push lives longer than a dispatch ping (24h) so a device that's
// offline at send time still receives it when it reconnects.
const PUSH_TTL_SECONDS = 24 * 60 * 60;

// Cap SMS at ~3 segments. Long announcements are read in full in the app; SMS
// is the "you have a message" nudge.
const SMS_MAX_CHARS = 450;

function buildPushPayload({ messageId, title, body, url }) {
  return JSON.stringify({
    // 📣 distinguishes admin messages from 🚖 dispatch / 🚨 SOS at a glance.
    title: `📣 ${title}`,
    // The OS truncates long bodies; the full text is in the in-app inbox.
    body,
    // Per-message tag so multiple announcements stack instead of replacing.
    tag: `admin-msg-${messageId}`,
    data: {
      type:      'admin_message',
      messageId,
      url:       url || '/',
    },
  });
}

function buildSmsBody({ title, body }) {
  return `${title}\n\n${body}`.slice(0, SMS_MAX_CHARS);
}

/**
 * Send a broadcast.
 *
 * @param {object} args
 * @param {number|null} args.adminId
 * @param {string}   args.title
 * @param {string}   args.body
 * @param {string|null} [args.url]
 * @param {number[]} [args.driverIds]  empty/omitted → blast to all active drivers
 * @param {boolean}  [args.sendSms]
 * @returns {Promise<{message:object, recipients:number, targetType:string,
 *                    push:{targeted,delivered,failed},
 *                    sms:{targeted,sent,failed}}>}
 */
async function broadcast({ adminId, title, body, url = null, driverIds = [], sendSms = false }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE);
  const cleanBody  = String(body  || '').trim().slice(0, MAX_BODY);
  if (!cleanTitle || !cleanBody) {
    const err = new Error('title and body are required');
    err.statusCode = 400;
    throw err;
  }

  const targetType = driverIds.length ? 'selected' : 'all';

  // Resolve the recipient set to *active* drivers only. A targeted send to an
  // inactive/unknown id is silently dropped (the whereIn just won't match it).
  const targets   = await Driver.listForBroadcast({ driverIds });
  const targetIds = targets.map((d) => d.id);

  // 1. Persist message + recipient rows (atomic) — the durable record.
  const message = await DriverMessage.createWithRecipients({
    adminId,
    title:      cleanTitle,
    body:       cleanBody,
    url,
    targetType,
    sendSms,
    driverIds:  targetIds,
  });

  // 2. Push fan-out — only to subscriptions belonging to the target drivers.
  let push = { targeted: 0, delivered: 0, failed: 0 };
  if (pushService.isConfigured() && targetIds.length) {
    const subs = await PushSubscription.findByRoleAndSubscriberIds('driver', targetIds);
    push = await pushService.sendToSubscriptions(
      subs,
      buildPushPayload({ messageId: message.id, title: cleanTitle, body: cleanBody, url }),
      {
        ttl:     PUSH_TTL_SECONDS,
        onStale: (endpoint) => PushSubscription.deleteByEndpoint(endpoint).catch(() => {}),
      },
    );
  }

  // 3. Optional SMS fan-out — to targets with a phone on file.
  let sms = { targeted: 0, sent: 0, failed: 0 };
  if (sendSms && smsService.isConfigured()) {
    const withPhone = targets.filter((d) => d.phone);
    sms.targeted = withPhone.length;
    const smsBody = buildSmsBody({ title: cleanTitle, body: cleanBody });
    const results = await Promise.allSettled(
      withPhone.map((d) => smsService.sendSms(d.phone, smsBody)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.ok) sms.sent++;
      else sms.failed++;
    }
  }

  // 4. Persist delivery counters back onto the message for the sent-history view.
  let updated = message;
  try {
    updated = await DriverMessage.updateDeliveryStats(message.id, {
      push_targeted:  push.targeted,
      push_delivered: push.delivered,
      push_failed:    push.failed,
      sms_targeted:   sms.targeted,
      sms_sent:       sms.sent,
      sms_failed:     sms.failed,
    });
  } catch (err) {
    console.warn('[Broadcast] Could not persist delivery stats:', err.message);
  }

  console.log(
    `[Broadcast] msg#${message.id} "${cleanTitle.slice(0, 40)}" ` +
    `target=${targetType} recipients=${targetIds.length} ` +
    `push=${push.delivered}/${push.targeted} sms=${sms.sent}/${sms.targeted}`,
  );

  return { message: updated, recipients: targetIds.length, targetType, push, sms };
}

module.exports = {
  broadcast,
  isPushConfigured: () => pushService.isConfigured(),
  isSmsConfigured:  () => smsService.isConfigured(),
  // Test-only helpers
  _buildPushPayload: buildPushPayload,
  _buildSmsBody:     buildSmsBody,
};
