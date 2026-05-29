/**
 * extractKnownErrorFromText — pure pattern matcher
 *
 * The Playwright wrapper (extractSanErrorMessage) tries DOM selectors first
 * and then falls through to this function with the page body text. The pure
 * half is what lets us assert behavior without spinning up Chromium.
 *
 * When a new SAN error pattern appears in production debug captures, add it
 * to KNOWN_SAN_ERROR_PATTERNS in botService.js and add a matching case here.
 *
 * Run: npx jest tests/unit/extractSanError.test.js
 */

const {
  _extractKnownErrorFromText:    extract,
  _extractGenericErrorFromText:  extractGeneric,
} = require('../../src/services/botService');

describe('extractKnownErrorFromText', () => {
  test('returns null for non-string / empty input', () => {
    expect(extract(null)).toBeNull();
    expect(extract(undefined)).toBeNull();
    expect(extract('')).toBeNull();
    expect(extract(42)).toBeNull();
    expect(extract({})).toBeNull();
  });

  test('matches "Vehicle not available for registration" verbatim', () => {
    const body = `
      SAN eDispatch
      Home Profile Logout
      Vehicle not available for registration
      Search button etc.
    `;
    expect(extract(body)).toBe('Vehicle not available for registration');
  });

  test('matches "Invalid username or password"', () => {
    expect(extract('Login failed: Invalid username or password.')).toBe('Invalid username or password');
  });

  test('regex pattern — vehicle eligibility variants', () => {
    expect(extract('Vehicle 4007 is not eligible for queue at this time'))
      .toMatch(/is not (?:eligible|authorized|available)/i);
    expect(extract('Vehicle ABC123 is not authorized'))
      .toMatch(/is not (?:eligible|authorized|available)/i);
  });

  test('regex pattern — permit / insurance expiry', () => {
    expect(extract('Permit expired on 2026-01-01.')).toBe('Permit expired');
    expect(extract('Insurance not found in our records')).toBe('Insurance not found');
  });

  test('regex pattern — account state', () => {
    // The matcher returns whatever the regex captured (the smallest sufficient
    // phrase). Partial is still useful — even "account locked" tells the
    // driver something concrete instead of "took too long".
    expect(extract('Driver account locked — contact dispatch')).toMatch(/account locked/i);
    expect(extract('Account suspended pending review')).toBe('Account suspended');
    expect(extract('User account deactivated')).toMatch(/account deactivated/i);
  });

  test('regex pattern — authorization', () => {
    expect(extract('You are not authorized to perform this action'))
      .toBe('You are not authorized');
  });

  test('returns null when no known pattern present', () => {
    expect(extract('Some random body text with no error indicators'))
      .toBeNull();
  });

  test('first matching pattern wins — verbatim string before regex variants', () => {
    // "Vehicle not available for registration" appears earlier in the
    // pattern list than the regex /Vehicle.* is not (?:eligible|...)/, so
    // it should win when both could match. (Verbatim is faster to evaluate
    // and the exact message is what we want when SAN renders it.)
    const body = 'Vehicle not available for registration\nVehicle X is not eligible';
    expect(extract(body)).toBe('Vehicle not available for registration');
  });
});

// ─── Generic catch-all — UNKNOWN errors still surface text ───────────────────
// This is the safety net that ensures "an error SAN throws that we haven't
// catalogued" doesn't silently become "took too long" for the driver.

describe('extractGenericErrorFromText — unknown error catch-all', () => {
  test('returns null for non-string / empty input', () => {
    expect(extractGeneric(null)).toBeNull();
    expect(extractGeneric(undefined)).toBeNull();
    expect(extractGeneric('')).toBeNull();
  });

  test('surfaces a never-seen-before error containing an error keyword', () => {
    // None of these match KNOWN_SAN_ERROR_PATTERNS but each contains
    // error-suggestive language a human can act on.
    expect(extractGeneric('Vehicle registration has been temporarily disabled by dispatch.'))
      .toBe('Vehicle registration has been temporarily disabled by dispatch.');
    expect(extractGeneric('Your subscription has expired. Please renew to continue.'))
      .toBe('Your subscription has expired. Please renew to continue.');
    expect(extractGeneric('Could not connect to dispatch service.'))
      .toBe('Could not connect to dispatch service.');
  });

  test('skips inline JavaScript / CSS source even when it contains "error"', () => {
    const noisy = `
      function showError() { document.getElementById('error').innerText = msg; }
      var errorClass = 'error-class';
      const isInvalid = (x) => x === null;
    `;
    expect(extractGeneric(noisy)).toBeNull();
  });

  test('picks the first error-like line in a multi-line body', () => {
    const body = [
      'Welcome to SAN eDispatch',
      'Home Profile Logout',
      'Permit verification failed for vehicle 4007.',
      'Some other footer text',
    ].join('\n');
    expect(extractGeneric(body)).toBe('Permit verification failed for vehicle 4007.');
  });

  test('ignores lines that are too long (likely template / page source)', () => {
    // Single contiguous line > MAX_ERROR_LINE_LEN (250 chars). Even though it
    // contains "error" we skip it — long unbroken lines are template/source,
    // not human-readable error copy.
    const longLine = 'This is a very long string about an error '.repeat(20);
    expect(extractGeneric(longLine)).toBeNull();
  });

  test('normalises whitespace in the surfaced message', () => {
    expect(extractGeneric('   Something   failed     unexpectedly   '))
      .toBe('Something failed unexpectedly');
  });

  test('returns null when nothing looks like an error', () => {
    expect(extractGeneric('All systems operational. Welcome.')).toBeNull();
  });
});
