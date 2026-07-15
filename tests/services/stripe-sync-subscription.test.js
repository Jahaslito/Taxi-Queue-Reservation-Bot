'use strict';

// Unit tests for pickRelevantSubscription — the pure chooser behind both the
// paywall sync endpoint (/driver/sync-subscription) and the duplicate-checkout
// guard. Given every subscription a customer has (any status), it must return
// the one that best represents their real access state: a live paid sub beats
// a dead one regardless of age; ties go to the most recently created.

const { _pickRelevantSubscription, _formatDeclineReason } = require('../../src/services/stripeService');

const sub = (id, status, created) => ({ id, status, created });

describe('stripeService._pickRelevantSubscription', () => {
  test('empty / missing list → null', () => {
    expect(_pickRelevantSubscription([])).toBeNull();
    expect(_pickRelevantSubscription()).toBeNull();
  });

  test('single subscription → returned as-is', () => {
    const only = sub('sub_1', 'active', 100);
    expect(_pickRelevantSubscription([only])).toBe(only);
  });

  test('active beats trialing, past_due and canceled', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_canceled', 'canceled', 400),
      sub('sub_active',   'active',   100),
      sub('sub_trial',    'trialing', 300),
      sub('sub_pastdue',  'past_due', 200),
    ]);
    expect(picked.id).toBe('sub_active');
  });

  test('the retry-checkout case: old canceled + new active → active wins even though older', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_new_canceled', 'canceled', 900),
      sub('sub_old_active',   'active',   100),
    ]);
    expect(picked.id).toBe('sub_old_active');
  });

  test('trialing beats past_due (live access state wins)', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_pastdue', 'past_due', 500),
      sub('sub_trial',   'trialing', 100),
    ]);
    expect(picked.id).toBe('sub_trial');
  });

  test('no live sub → best of the rest (past_due over canceled)', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_canceled', 'canceled', 900),
      sub('sub_pastdue',  'past_due', 100),
    ]);
    expect(picked.id).toBe('sub_pastdue');
  });

  test('same status → most recently created wins', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_older', 'active', 100),
      sub('sub_newer', 'active', 200),
    ]);
    expect(picked.id).toBe('sub_newer');
  });

  test('unknown status ranks below every known status', () => {
    const picked = _pickRelevantSubscription([
      sub('sub_weird',    'paused',   900),
      sub('sub_canceled', 'canceled', 100),
    ]);
    expect(picked.id).toBe('sub_canceled');
  });

  test('does not mutate the input array', () => {
    const input = [sub('a', 'canceled', 1), sub('b', 'active', 2)];
    const copy  = [...input];
    _pickRelevantSubscription(input);
    expect(input).toEqual(copy);
  });
});

// The decline-reason formatter behind drivers.last_payment_error — the text
// shown on the Payment Required screen and in the payment-failed email.
describe('stripeService._formatDeclineReason', () => {
  test('uses Stripe\'s cardholder message verbatim when present', () => {
    expect(_formatDeclineReason({ message: 'Your card has insufficient funds.' }))
      .toBe('Your card has insufficient funds.');
  });

  test('prefixes card brand + last4 when available', () => {
    expect(_formatDeclineReason({
      message: 'Your card has insufficient funds.',
      brand:   'visa',
      last4:   '4242',
    })).toBe('Visa •••• 4242: Your card has insufficient funds.');
  });

  test('last4 without brand still identifies the card', () => {
    expect(_formatDeclineReason({ message: 'Declined.', last4: '4242' }))
      .toBe('Card •••• 4242: Declined.');
  });

  test('falls back to decline-code text when message is missing', () => {
    expect(_formatDeclineReason({ declineCode: 'insufficient_funds' }))
      .toBe('Your card has insufficient funds.');
    expect(_formatDeclineReason({ declineCode: 'expired_card' }))
      .toBe('Your card has expired.');
  });

  test('unknown code / empty input → generic non-empty message', () => {
    expect(_formatDeclineReason({ declineCode: 'mystery_code' })).toBe('Your card was declined.');
    expect(_formatDeclineReason({})).toBe('Your card was declined.');
    expect(_formatDeclineReason()).toBe('Your card was declined.');
  });

  test('caps output under the 300-char column', () => {
    const out = _formatDeclineReason({ message: 'x'.repeat(500) });
    expect(out.length).toBeLessThanOrEqual(280);
  });
});
