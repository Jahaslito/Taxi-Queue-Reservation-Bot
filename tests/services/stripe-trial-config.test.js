'use strict';

// Unit tests for the trial-config logic that drives Checkout's `subscription_data`.
// We test the pure function `_trialConfig(nowSec, pauseUntilSec)` so we don't
// have to mock the Stripe SDK — pure inputs in, pure config out.

const { _trialConfig, _skipTrialConfig } = require('../../src/services/stripeService');

const ONE_DAY = 24 * 60 * 60;

describe('stripeService._trialConfig — trial selection', () => {
  // Pick a fixed "now" so the math is easy to read.
  const NOW = 1_700_000_000;

  describe('no pause window active', () => {
    test('STRIPE_PAUSE_UNTIL unset (NaN) → default 14-day trial', () => {
      expect(_trialConfig(NOW, NaN)).toEqual({ trial_period_days: 14 });
    });

    test('STRIPE_PAUSE_UNTIL = 0 → default 14-day trial', () => {
      expect(_trialConfig(NOW, 0)).toEqual({ trial_period_days: 14 });
    });

    test('pauseUntil already in the past → default 14-day trial', () => {
      expect(_trialConfig(NOW, NOW - 1000)).toEqual({ trial_period_days: 14 });
    });

    test('pauseUntil exactly = now (edge) → default 14-day trial', () => {
      // We treat "pause window over" inclusively so signups right at the
      // boundary don't get a one-second extension.
      expect(_trialConfig(NOW, NOW)).toEqual({ trial_period_days: 14 });
    });
  });

  describe('pause window active — short pause (5 days)', () => {
    const pauseUntil = NOW + 5 * ONE_DAY;

    test('signs up at start: trial extended? no — natural 14-day end already after pause', () => {
      // natural end = NOW + 14d, pause ends at NOW + 5d → no extension needed
      expect(_trialConfig(NOW, pauseUntil)).toEqual({
        trial_end: NOW + 14 * ONE_DAY,
      });
    });
  });

  describe('pause window active — long pause (21 days)', () => {
    const pauseUntil = NOW + 21 * ONE_DAY;

    test('signs up at start of pause → trial extended to pause-end (21 days)', () => {
      expect(_trialConfig(NOW, pauseUntil)).toEqual({
        trial_end: pauseUntil,
      });
    });

    test('signs up 7 days into the pause → trial ends at pause-end (still 14 days from signup)', () => {
      const signupTime = NOW + 7 * ONE_DAY;
      // Pause ends 14 days after signup (21 - 7 = 14) — matches the natural trial
      expect(_trialConfig(signupTime, pauseUntil)).toEqual({
        trial_end: pauseUntil,
      });
    });

    test('signs up 10 days into pause → natural 14-day trial exceeds pause-end, use natural', () => {
      const signupTime = NOW + 10 * ONE_DAY;
      // Natural end = NOW + 10d + 14d = NOW + 24d, which is > pauseUntil (NOW + 21d)
      // So the natural trial wins (no need to extend)
      expect(_trialConfig(signupTime, pauseUntil)).toEqual({
        trial_end: signupTime + 14 * ONE_DAY,
      });
    });

    test('signs up on last day of pause → natural 14-day trial used', () => {
      const signupTime = NOW + 20 * ONE_DAY;
      expect(_trialConfig(signupTime, pauseUntil)).toEqual({
        trial_end: signupTime + 14 * ONE_DAY,
      });
    });

    test('every driver gets AT LEAST their default 14-day trial', () => {
      // Spot check across the window — invariant: trial_end >= now + 14 days
      for (let dayOffset = 0; dayOffset < 21; dayOffset++) {
        const signupTime = NOW + dayOffset * ONE_DAY;
        const config     = _trialConfig(signupTime, pauseUntil);
        const endTime    = config.trial_end ?? signupTime + config.trial_period_days * ONE_DAY;
        expect(endTime).toBeGreaterThanOrEqual(signupTime + 14 * ONE_DAY);
      }
    });

    test('no driver is charged inside the pause window', () => {
      // Invariant: trial_end >= pauseUntil for any signup during the pause
      for (let dayOffset = 0; dayOffset < 21; dayOffset++) {
        const signupTime = NOW + dayOffset * ONE_DAY;
        const config     = _trialConfig(signupTime, pauseUntil);
        const endTime    = config.trial_end ?? signupTime + config.trial_period_days * ONE_DAY;
        expect(endTime).toBeGreaterThanOrEqual(pauseUntil);
      }
    });
  });

  describe('shape — Stripe accepts trial_period_days OR trial_end, never both', () => {
    test('no pause → returns trial_period_days only', () => {
      const result = _trialConfig(NOW, 0);
      expect(result).toHaveProperty('trial_period_days');
      expect(result).not.toHaveProperty('trial_end');
    });

    test('active pause → returns trial_end only', () => {
      const result = _trialConfig(NOW, NOW + 21 * ONE_DAY);
      expect(result).toHaveProperty('trial_end');
      expect(result).not.toHaveProperty('trial_period_days');
    });
  });
});

describe('stripeService._skipTrialConfig — grandfathered reactivation (no free trial)', () => {
  const NOW = 1_700_000_000;

  describe('no pause window active', () => {
    test('STRIPE_PAUSE_UNTIL unset (NaN) → null (charge at checkout)', () => {
      expect(_skipTrialConfig(NOW, NaN)).toBeNull();
    });

    test('STRIPE_PAUSE_UNTIL = 0 → null (charge at checkout)', () => {
      expect(_skipTrialConfig(NOW, 0)).toBeNull();
    });

    test('pauseUntil in the past → null (charge at checkout)', () => {
      expect(_skipTrialConfig(NOW, NOW - 1000)).toBeNull();
    });

    test('pauseUntil exactly = now (boundary) → null (charge at checkout)', () => {
      expect(_skipTrialConfig(NOW, NOW)).toBeNull();
    });
  });

  describe('pause window active — defer first charge to pause-end, no extra trial', () => {
    test('returns trial_end = pause-end exactly (no +14 days)', () => {
      const pauseUntil = NOW + 21 * ONE_DAY;
      expect(_skipTrialConfig(NOW, pauseUntil)).toEqual({ trial_end: pauseUntil });
    });

    test('never charges inside the pause window', () => {
      const pauseUntil = NOW + 10 * ONE_DAY;
      for (let dayOffset = 0; dayOffset < 10; dayOffset++) {
        const t = NOW + dayOffset * ONE_DAY;
        expect(_skipTrialConfig(t, pauseUntil).trial_end).toBeGreaterThanOrEqual(pauseUntil);
      }
    });
  });
});
