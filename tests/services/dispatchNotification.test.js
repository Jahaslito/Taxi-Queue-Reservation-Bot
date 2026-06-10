/**
 * Dispatch Notification Service — unit tests
 *
 * Covers:
 *   • Message formatting (driver name + cab + terminal + 25-min ETA)
 *   • SMS delegation to smsService with the correct phone + body
 *   • Push fan-out scoped to the driver's own subscriptions only
 *   • Per-driver-per-terminal-per-day dedupe (no double-fire on poll races)
 *   • No-phone path skips SMS but still fires push
 *   • Push not configured → still attempts SMS, no throw
 *
 * Strategy
 * ────────
 * web-push and the PushSubscription model are mocked at the module boundary;
 * smsService is real but we swap sendSms with a jest.fn() per test. That keeps
 * the format-string assertions readable without hand-rolling a fake provider.
 */

'use strict';

jest.mock('web-push');
jest.mock('../../src/models/PushSubscription');

const webpush          = require('web-push');
const PushSubscription = require('../../src/models/PushSubscription');
const smsService       = require('../../src/services/smsService');
const dispatchNotify   = require('../../src/services/dispatchNotificationService');

// ─── Fixtures ────────────────────────────────────────────────────────────────
const DRIVER_ID  = 187;
// Strict policy: the monitor only calls notifyDispatch once V Holding's DEST
// column is populated. Tests reflect that — terminal is always set.
const DRIVER     = {
  driverId:      DRIVER_ID,
  driverName:    'Mataan Noor',
  vehicleNumber: '0187',
  phone:         '+16195551234',
  terminal:      'T1',
};

// A fixed PT noon so the ETA assertion is deterministic ("12:25 PM").
// 2026-06-09 12:00:00 PT === 19:00:00 UTC (PDT = UTC-7 in June).
const NOON_PT = new Date('2026-06-09T19:00:00.000Z');

beforeEach(() => {
  // Module mocks (jest.mock at the top) hold their call counts across tests,
  // so reset everything before re-installing the per-test default behavior.
  jest.clearAllMocks();

  dispatchNotify._clearDedupeForTest();
  dispatchNotify._setPushConfiguredForTest(true);

  PushSubscription.findAllByRole.mockResolvedValue([]);
  PushSubscription.touch.mockResolvedValue();
  PushSubscription.deleteByEndpoint.mockResolvedValue();

  webpush.sendNotification.mockResolvedValue({});

  jest.spyOn(smsService, 'sendSms').mockResolvedValue({ ok: true, id: 'msg_1' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Message formatting ──────────────────────────────────────────────────────

describe('message formatting', () => {
  test('SMS body — includes name, cab, terminal, and 25-min ETA', () => {
    const body = dispatchNotify._buildSmsBody({
      driverName:    'Mataan Noor',
      vehicleNumber: '0187',
      terminal:      'T1',
      etaText:       '12:25 PM',
    });
    expect(body).toContain('Mataan Noor');
    expect(body).toContain('#0187');
    expect(body).toContain('T1');
    expect(body).toContain('12:25 PM');
    expect(body.length).toBeLessThanOrEqual(160);
  });

  test('push payload — title and data carry the terminal name', () => {
    const p = JSON.parse(dispatchNotify._buildPushPayload({
      driverName:    'Mataan Noor',
      vehicleNumber: '0187',
      terminal:      'T2',
      etaText:       '12:25 PM',
    }));
    expect(p.title).toContain('T2');
    expect(p.body).toContain('Mataan Noor');
    expect(p.body).toContain('12:25 PM');
    expect(p.tag).toBe('dispatch-0187');
    expect(p.data.type).toBe('dispatch');
    expect(p.data.terminal).toBe('T2');
    expect(p.data.etaMinutes).toBe(25);
  });

  test('ETA is exactly 25 minutes ahead in Pacific Time', () => {
    const eta = dispatchNotify._formatEtaPT(NOON_PT);
    expect(eta).toBe('12:25 PM');
  });
});

// ─── notifyDispatch — channel orchestration ──────────────────────────────────

describe('notifyDispatch', () => {
  test('sends SMS to the driver\'s phone with the formatted body', async () => {
    await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });

    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = smsService.sendSms.mock.calls[0];
    expect(to).toBe('+16195551234');
    expect(body).toContain('Mataan Noor');
    expect(body).toContain('#0187');
    expect(body).toContain('T1');
    expect(body).toContain('12:25 PM');
  });

  test('push fan-out targets only the dispatched driver\'s own subscriptions', async () => {
    PushSubscription.findAllByRole.mockResolvedValue([
      // Different driver — must NOT receive this dispatch.
      { endpoint: 'https://example.com/other', p256dh_key: 'k', auth_key: 'a', subscriber_id: 999 },
      // The right driver, two devices (phone + tablet).
      { endpoint: 'https://example.com/phone',  p256dh_key: 'k', auth_key: 'a', subscriber_id: DRIVER_ID },
      { endpoint: 'https://example.com/tablet', p256dh_key: 'k', auth_key: 'a', subscriber_id: DRIVER_ID },
    ]);

    const result = await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });

    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const endpoints = webpush.sendNotification.mock.calls.map(([sub]) => sub.endpoint);
    expect(endpoints).toEqual(expect.arrayContaining([
      'https://example.com/phone',
      'https://example.com/tablet',
    ]));
    expect(endpoints).not.toContain('https://example.com/other');
    expect(result.pushSent).toBe(2);
  });

  test('repeats for same driver+day are deduped silently (dispatch fires once per day)', async () => {
    const first  = await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });
    const second = await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(smsService.sendSms).toHaveBeenCalledTimes(1); // not 2
  });

  test('missing phone → still fires push, SMS is skipped without error', async () => {
    PushSubscription.findAllByRole.mockResolvedValue([
      { endpoint: 'https://example.com/phone', p256dh_key: 'k', auth_key: 'a', subscriber_id: DRIVER_ID },
    ]);

    const result = await dispatchNotify.notifyDispatch({ ...DRIVER, phone: null, now: NOON_PT });

    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(result.smsSent).toBe(false);
    expect(result.pushSent).toBe(1);
  });

  test('push not configured → SMS still goes out', async () => {
    dispatchNotify._setPushConfiguredForTest(false);

    const result = await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });

    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(result.pushSent).toBe(0);
    expect(result.smsSent).toBe(true);
  });

  test('a 410-Gone subscription is pruned from the DB', async () => {
    PushSubscription.findAllByRole.mockResolvedValue([
      { endpoint: 'https://example.com/dead', p256dh_key: 'k', auth_key: 'a', subscriber_id: DRIVER_ID },
    ]);
    const err = new Error('gone'); err.statusCode = 410;
    webpush.sendNotification.mockRejectedValue(err);

    await dispatchNotify.notifyDispatch({ ...DRIVER, now: NOON_PT });

    expect(PushSubscription.deleteByEndpoint).toHaveBeenCalledWith('https://example.com/dead');
  });

  test('missing driverId is a no-op (defensive)', async () => {
    const result = await dispatchNotify.notifyDispatch({ ...DRIVER, driverId: null });

    expect(result.skipped).toBe('no_driver');
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('null terminal — refuses to send (monitor must retry next poll)', async () => {
    // Hard policy: never notify without a known terminal. An unknown DEST
    // isn't actionable in 25 minutes. The monitor keeps the
    // dispatchNotifyPending flag true and retries on the next tick.
    const result = await dispatchNotify.notifyDispatch({ ...DRIVER, terminal: null, now: NOON_PT });

    expect(result.skipped).toBe('no_terminal');
    expect(result.smsSent).toBe(false);
    expect(result.pushSent).toBe(0);
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
