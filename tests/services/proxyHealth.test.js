/**
 * Proxy health / circuit breaker tests
 *
 * The breaker has three "no proxy" paths — operator kill switch, missing
 * env, breaker open — each tested independently. Time advancement uses the
 * injectable `now` parameter on the public API so we don't have to manage
 * jest fake timers (and the tests stay deterministic).
 *
 * Run: npx jest tests/services/proxyHealth.test.js
 */

// IMPORTANT: env values that affect module-load constants (PROXY_ENABLED,
// PROXY_FAIL_THRESHOLD, PROXY_COOLDOWN_MS) are read at require() time. The
// tests below either use jest.isolateModules to re-import with different env
// values, or test runtime-only behavior under the default thresholds.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env so one test's mutations don't leak into the next file's load.
  process.env = { ...ORIGINAL_ENV };
});

describe('shouldUseProxy — kill-switch paths', () => {
  test('returns false when PROXY_SERVER is not set', () => {
    jest.isolateModules(() => {
      delete process.env.PROXY_SERVER;
      process.env.PROXY_ENABLED = 'true';
      const ph = require('../../src/services/proxyHealthService');
      expect(ph.shouldUseProxy()).toBe(false);
      expect(ph.getState().state).toBe('HEALTHY'); // breaker is fine, just no proxy
      expect(ph.getState().proxyConfigured).toBe(false);
    });
  });

  test('returns false when PROXY_ENABLED=false (operator kill switch)', () => {
    jest.isolateModules(() => {
      process.env.PROXY_SERVER = 'gate.example.com:7000';
      process.env.PROXY_ENABLED = 'false';
      const ph = require('../../src/services/proxyHealthService');
      expect(ph.shouldUseProxy()).toBe(false);
      expect(ph.getState().enabled).toBe(false);
    });
  });

  test('returns true when both proxy is set and enabled (and breaker closed)', () => {
    jest.isolateModules(() => {
      process.env.PROXY_SERVER = 'gate.example.com:7000';
      delete process.env.PROXY_ENABLED;
      const ph = require('../../src/services/proxyHealthService');
      expect(ph.shouldUseProxy()).toBe(true);
    });
  });
});

describe('circuit breaker — state transitions', () => {
  // These tests share one module load so they can drive consecutive state
  // transitions. _reset() is called in beforeEach to guarantee isolation.
  let ph;

  beforeEach(() => {
    process.env.PROXY_SERVER  = 'gate.example.com:7000';
    process.env.PROXY_ENABLED = 'true';
    jest.isolateModules(() => {
      ph = require('../../src/services/proxyHealthService');
    });
    ph._reset();
  });

  test('starts HEALTHY with no failures', () => {
    expect(ph.shouldUseProxy()).toBe(true);
    expect(ph.getState().state).toBe('HEALTHY');
    expect(ph.getState().consecutiveFails).toBe(0);
  });

  test('one failure marks DEGRADED but still allows proxy', () => {
    ph.reportFailure('fetch failed');
    expect(ph.shouldUseProxy()).toBe(true); // still under threshold
    expect(ph.getState().state).toBe('DEGRADED');
    expect(ph.getState().consecutiveFails).toBe(1);
  });

  test('reaching FAIL_THRESHOLD opens the breaker', () => {
    const t = ph.FAIL_THRESHOLD;
    for (let i = 0; i < t; i++) ph.reportFailure(`fail-${i}`);
    expect(ph.shouldUseProxy()).toBe(false);
    expect(ph.getState().state).toBe('OPEN');
    expect(ph.getState().cooldownRemainingMs).toBeGreaterThan(0);
  });

  test('extra failures during cooldown do NOT extend the cooldown', () => {
    const t        = ph.FAIL_THRESHOLD;
    const now0     = 1_000_000;
    for (let i = 0; i < t; i++) ph.reportFailure('initial', { now: now0 });
    const tripEnd0 = now0 + ph.COOLDOWN_MS;
    // 10s into cooldown, another failure arrives — should be ignored.
    ph.reportFailure('during-cooldown', { now: now0 + 10_000 });
    const tripEnd1 = now0 + 10_000 + ph.getState({ now: now0 + 10_000 }).cooldownRemainingMs;
    expect(tripEnd1).toBe(tripEnd0);
  });

  test('cooldown elapses → shouldUseProxy() returns true again', () => {
    const now0 = 1_000_000;
    for (let i = 0; i < ph.FAIL_THRESHOLD; i++) ph.reportFailure('x', { now: now0 });
    expect(ph.shouldUseProxy({ now: now0 + 1 })).toBe(false);
    expect(ph.shouldUseProxy({ now: now0 + ph.COOLDOWN_MS })).toBe(true);
  });

  test('reportSuccess after cooldown closes the breaker permanently (until next trip)', () => {
    const now0 = 1_000_000;
    for (let i = 0; i < ph.FAIL_THRESHOLD; i++) ph.reportFailure('x', { now: now0 });
    ph.reportSuccess({ now: now0 + ph.COOLDOWN_MS });
    expect(ph.getState().state).toBe('HEALTHY');
    expect(ph.getState().consecutiveFails).toBe(0);
  });

  test('reportSuccess at any point resets the failure counter', () => {
    ph.reportFailure('a');
    ph.reportFailure('b');
    expect(ph.getState().consecutiveFails).toBe(2);
    ph.reportSuccess();
    expect(ph.getState().consecutiveFails).toBe(0);
    expect(ph.getState().state).toBe('HEALTHY');
  });

  test('totalTrips increments on each breaker open', () => {
    const now0 = 1_000_000;
    for (let i = 0; i < ph.FAIL_THRESHOLD; i++) ph.reportFailure('a', { now: now0 });
    expect(ph.getState().totalTrips).toBe(1);

    // Recover, then trip again
    ph.reportSuccess({ now: now0 + ph.COOLDOWN_MS });
    const now1 = now0 + ph.COOLDOWN_MS + 1_000;
    for (let i = 0; i < ph.FAIL_THRESHOLD; i++) ph.reportFailure('b', { now: now1 });
    expect(ph.getState().totalTrips).toBe(2);
    expect(ph.getState().lastTripReason).toBe('b');
  });
});

describe('getState shape — for the admin endpoint', () => {
  let ph;

  beforeEach(() => {
    process.env.PROXY_SERVER  = 'gate.example.com:7000';
    process.env.PROXY_ENABLED = 'true';
    jest.isolateModules(() => {
      ph = require('../../src/services/proxyHealthService');
    });
    ph._reset();
  });

  test('returns the full schema the UI expects', () => {
    const s = ph.getState();
    expect(s).toEqual(expect.objectContaining({
      enabled:             expect.any(Boolean),
      proxyConfigured:     expect.any(Boolean),
      healthy:             expect.any(Boolean),
      state:               expect.stringMatching(/HEALTHY|DEGRADED|OPEN/),
      consecutiveFails:    expect.any(Number),
      cooldownRemainingMs: expect.any(Number),
      failThreshold:       expect.any(Number),
      cooldownMs:          expect.any(Number),
      totalTrips:          expect.any(Number),
    }));
  });
});
