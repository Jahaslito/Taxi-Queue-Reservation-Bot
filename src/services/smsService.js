'use strict';

// ─── SMS Service — Telnyx ─────────────────────────────────────────────────────
//
// Outbound SMS via Telnyx Messaging API. Telnyx was chosen as the cheapest
// of the SMS providers evaluated (~$0.004/msg US outbound vs ~$0.0079 Twilio).
// We hit the HTTP API directly to avoid pulling in the telnyx SDK — keeps the
// dep tree small and matches how sosService talks to web-push (single helper
// module, no abstraction layer).
//
// Failure model: SMS is a best-effort notification, never the source of truth.
// Errors are logged but never rejected to the caller. Missing config is a
// warn-once and a no-op — local dev runs cleanly without Telnyx creds.

const { fetch: ufetch } = require('undici');

const API_URL = 'https://api.telnyx.com/v2/messages';

const TELNYX_API_KEY     = process.env.TELNYX_API_KEY     || null;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || null;

let configured = !!(TELNYX_API_KEY && TELNYX_FROM_NUMBER);
let warnedMissingConfig = false;

function isConfigured() {
  return configured;
}

/**
 * Send an SMS. Resolves to { ok: true, id } on success or { ok: false, reason }
 * on failure. Never throws — the caller (notification fan-out) keeps moving
 * even if Telnyx is down.
 *
 * @param {string} to    E.164 phone number (e.g. "+16195551234"). Numbers
 *                       without a leading "+" are sent as-is to Telnyx, which
 *                       will reject them; we don't try to be clever about
 *                       formatting here.
 * @param {string} body  Message text (segmented automatically by Telnyx).
 */
async function sendSms(to, body) {
  if (!configured) {
    if (!warnedMissingConfig) {
      console.warn('[SMS] Telnyx not configured — set TELNYX_API_KEY and TELNYX_FROM_NUMBER. SMS notifications disabled.');
      warnedMissingConfig = true;
    }
    return { ok: false, reason: 'not_configured' };
  }
  if (!to || !body) {
    return { ok: false, reason: 'missing_to_or_body' };
  }

  try {
    const res = await ufetch(API_URL, {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: TELNYX_FROM_NUMBER,
        to,
        text: body,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[SMS] Telnyx send to ${to} failed: HTTP ${res.status} ${errBody.slice(0, 200)}`);
      return { ok: false, reason: `http_${res.status}` };
    }

    const json = await res.json().catch(() => ({}));
    const id   = json?.data?.id ?? null;
    return { ok: true, id };
  } catch (err) {
    console.warn(`[SMS] Telnyx send to ${to} threw: ${err.message}`);
    return { ok: false, reason: 'exception' };
  }
}

module.exports = {
  sendSms,
  isConfigured,
  // Test-only: lets the test suite force-configure or clear the warned flag
  // without juggling environment variables across describe blocks.
  _setConfiguredForTest: (v) => { configured = !!v; },
  _resetWarnedFlagForTest: () => { warnedMissingConfig = false; },
};
