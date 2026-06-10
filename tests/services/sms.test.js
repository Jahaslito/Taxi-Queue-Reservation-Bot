/**
 * SMS Service — smoke tests
 *
 * The Telnyx HTTP API is mocked at the undici-fetch boundary. We don't try to
 * cover Telnyx's surface area — just that sendSms:
 *   • no-ops cleanly when the API key / from-number aren't set
 *   • POSTs the right JSON shape to the right URL when configured
 *   • returns { ok: false } (never throws) on HTTP error or network failure
 *   • rejects missing args before touching the network
 */

'use strict';

jest.mock('undici', () => ({
  fetch: jest.fn(),
}));

const { fetch: ufetch } = require('undici');
const sms               = require('../../src/services/smsService');

function ok(body = { data: { id: 'msg_123' } }) {
  return {
    ok:     true,
    status: 200,
    json:   async () => body,
    text:   async () => JSON.stringify(body),
  };
}

function httpError(status, body = '') {
  return {
    ok:     false,
    status,
    text:   async () => body,
    json:   async () => ({}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sms._resetWarnedFlagForTest();
});

describe('sendSms — not configured', () => {
  test('returns not_configured and never touches the network', async () => {
    sms._setConfiguredForTest(false);
    const res = await sms.sendSms('+16195551234', 'Hi');
    expect(res).toEqual({ ok: false, reason: 'not_configured' });
    expect(ufetch).not.toHaveBeenCalled();
  });
});

describe('sendSms — configured', () => {
  beforeEach(() => {
    sms._setConfiguredForTest(true);
  });

  test('POSTs JSON to the Telnyx messages endpoint with to/from/text', async () => {
    ufetch.mockResolvedValue(ok());

    const res = await sms.sendSms('+16195551234', 'Dispatch to T1');

    expect(res.ok).toBe(true);
    expect(res.id).toBe('msg_123');

    expect(ufetch).toHaveBeenCalledTimes(1);
    const [url, init] = ufetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toMatch(/^Bearer /);

    const body = JSON.parse(init.body);
    expect(body.to).toBe('+16195551234');
    expect(body.text).toBe('Dispatch to T1');
    // `from` comes from TELNYX_FROM_NUMBER which is null in the test env —
    // smsService passes whatever it has. We just check the field is present
    // so the shape matches Telnyx's contract.
    expect(body).toHaveProperty('from');
  });

  test('HTTP non-2xx → ok:false with reason carrying the status code', async () => {
    ufetch.mockResolvedValue(httpError(422, '{"errors":[{"detail":"invalid to"}]}'));

    const res = await sms.sendSms('+16195551234', 'Hi');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('http_422');
  });

  test('fetch throws → ok:false with reason=exception (never propagates)', async () => {
    ufetch.mockRejectedValue(new Error('ECONNRESET'));

    const res = await sms.sendSms('+16195551234', 'Hi');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('exception');
  });

  test('missing to or body → ok:false without hitting the network', async () => {
    const a = await sms.sendSms('', 'Hi');
    const b = await sms.sendSms('+16195551234', '');

    expect(a).toEqual({ ok: false, reason: 'missing_to_or_body' });
    expect(b).toEqual({ ok: false, reason: 'missing_to_or_body' });
    expect(ufetch).not.toHaveBeenCalled();
  });
});
