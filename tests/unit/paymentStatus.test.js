'use strict';

// Unit tests for derivePaymentStatus — pure mapping of billing columns to the
// admin-facing payment status badge + the noCard flag that gates the lock action.

const { derivePaymentStatus } = require('../../src/services/paymentStatus');

const future = () => new Date(Date.now() + 3 * 86_400_000);
const past   = () => new Date(Date.now() - 2 * 86_400_000);

describe('derivePaymentStatus', () => {
  describe('card_required_by stamped (no card on file)', () => {
    test('active + future deadline → grace, noCard', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'active', card_required_by: future() });
      expect(s.code).toBe('card_grace');
      expect(s.noCard).toBe(true);
      expect(s.label).toMatch(/left/);
    });

    test('active + past deadline → overdue, noCard', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'active', card_required_by: past() });
      expect(s.code).toBe('card_overdue');
      expect(s.noCard).toBe(true);
    });

    test('deactivated + deadline → locked out, noCard', () => {
      const s = derivePaymentStatus({ is_active: false, subscription_status: 'past_due', card_required_by: past() });
      expect(s.code).toBe('card_locked');
      expect(s.noCard).toBe(true);
    });
  });

  describe('no stamp — inferred from subscription', () => {
    test('active + customer id → card on file', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'active', stripe_customer_id: 'cus_1' });
      expect(s.code).toBe('card_on_file');
      expect(s.noCard).toBe(false);
    });

    test('trialing + customer id → card on file (trial)', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'trialing', stripe_customer_id: 'cus_1' });
      expect(s.code).toBe('trialing');
      expect(s.noCard).toBe(false);
    });

    test('active + NO customer id → grandfathered, noCard (unverified)', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'active', stripe_customer_id: null });
      expect(s.code).toBe('grandfathered');
      expect(s.noCard).toBe(true);
    });

    test('past_due → not flagged as noCard (real subscriber, has customer)', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: 'past_due', stripe_customer_id: 'cus_1' });
      expect(s.code).toBe('past_due');
      expect(s.noCard).toBe(false);
    });

    test('no subscription → none, noCard', () => {
      const s = derivePaymentStatus({ is_active: true, subscription_status: null });
      expect(s.code).toBe('none');
      expect(s.noCard).toBe(true);
    });
  });

  test('stamp takes precedence over subscription_status', () => {
    // Even though status is "active", a stamp means no card → grace wins
    const s = derivePaymentStatus({ is_active: true, subscription_status: 'active', stripe_customer_id: 'cus_1', card_required_by: future() });
    expect(s.code).toBe('card_grace');
  });
});
