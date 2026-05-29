/**
 * classifyFailure — bot debug-capture label picker
 *
 * Pure function: takes the URL the page was on at the moment of failure plus
 * the thrown error message, returns a label string. The label becomes the
 * filename suffix for the debug screenshot so admins can grep specific
 * failure modes in /admin/bot-debug instead of opening each PNG.
 *
 * Run: npx jest tests/unit/classifyFailure.test.js
 */

const { _classifyFailure } = require('../../src/services/botService');

describe('classifyFailure', () => {
  describe('non-timeout errors', () => {
    test('any non-timeout error returns "error"', () => {
      expect(_classifyFailure({
        urlAtError:   'https://san.gtcvms.com/anywhere',
        errorMessage: 'Vehicle 4007 not found',
      })).toBe('error');
    });

    test('missing inputs default to "error"', () => {
      expect(_classifyFailure()).toBe('error');
      expect(_classifyFailure({})).toBe('error');
    });
  });

  describe('timeouts — classification by URL', () => {
    const TIMEOUT_MSG = 'page.waitForFunction: Timeout 60000ms exceeded.';

    test('blank URL → goto_timeout (initial navigation never completed)', () => {
      expect(_classifyFailure({ urlAtError: '', errorMessage: TIMEOUT_MSG }))
        .toBe('goto_timeout');
      expect(_classifyFailure({ urlAtError: 'about:blank', errorMessage: TIMEOUT_MSG }))
        .toBe('goto_timeout');
    });

    test('on the OIDC login page → login_timeout (the 4007/email-username case)', () => {
      expect(_classifyFailure({
        urlAtError:   'https://san.gtcvms.com/GsiIdentityServer/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize',
        errorMessage: 'page.waitForURL: Timeout 60000ms exceeded.',
      })).toBe('login_timeout');
    });

    test('elsewhere on the OIDC host → login_timeout', () => {
      expect(_classifyFailure({
        urlAtError:   'https://san.gtcvms.com/GsiIdentityServer/connect/authorize',
        errorMessage: TIMEOUT_MSG,
      })).toBe('login_timeout');
    });

    test('on the signin-oidc callback → oidc_timeout', () => {
      expect(_classifyFailure({
        urlAtError:   'https://san.gtcvms.com/gsidispatch.edispatch/signin-oidc',
        errorMessage: TIMEOUT_MSG,
      })).toBe('oidc_timeout');
    });

    test('on the app host (not signin-oidc) → search_timeout', () => {
      expect(_classifyFailure({
        urlAtError:   'https://san.gtcvms.com/gsidispatch.edispatch/search',
        errorMessage: TIMEOUT_MSG,
      })).toBe('search_timeout');
    });

    test('URL that does not match any host → catch-all "timeout"', () => {
      expect(_classifyFailure({
        urlAtError:   'https://elsewhere.example.com/foo',
        errorMessage: TIMEOUT_MSG,
      })).toBe('timeout');
    });
  });

  describe('timeout message variants', () => {
    test.each([
      'page.waitForFunction: Timeout 60000ms exceeded.',
      'page.waitForURL: Timeout 60000ms exceeded.',
      'page.goto: Timeout 60000ms exceeded.',
      'navigation was aborted due to timeout',
      'Request timed out',
    ])('"%s" classifies as a timeout (not as "error")', (msg) => {
      const out = _classifyFailure({ urlAtError: '', errorMessage: msg });
      expect(out).not.toBe('error');
    });
  });
});
