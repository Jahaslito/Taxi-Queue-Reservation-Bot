/**
 * Unit tests — cryptoService
 *
 * Pure function tests: no DB, no HTTP.
 * Run independently: npx jest tests/unit/crypto.test.js
 */
const { encrypt, decrypt } = require('../../src/services/cryptoService');

describe('cryptoService', () => {
  // 1
  test('encrypt → decrypt round-trips to the original string', () => {
    const original = 'my-secret-san-password!@#$%';
    expect(decrypt(encrypt(original))).toBe(original);
  });

  // 2
  test('same input produces a different ciphertext on each call (random IV)', () => {
    const text = 'same-input-every-time';
    const first  = encrypt(text);
    const second = encrypt(text);
    expect(first).not.toBe(second);
  });

  // 3
  test('tampered ciphertext throws on decrypt', () => {
    const encrypted = encrypt('hello world');
    // Corrupt the last 4 characters of the encrypted hex portion
    const tampered = encrypted.slice(0, -4) + 'xxxx';
    expect(() => decrypt(tampered)).toThrow();
  });

  // 4
  test('empty string survives the round-trip', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });
});
