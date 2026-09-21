const { maskDl } = require('../../src/utils/pii');

describe('maskDl', () => {
  test('keeps the last 3 chars, masks the rest', () => {
    expect(maskDl('B3057946')).toBe('•••••946');
    expect(maskDl('D1015198')).toBe('•••••198');
  });

  test('empty / null → null', () => {
    expect(maskDl('')).toBeNull();
    expect(maskDl(null)).toBeNull();
    expect(maskDl(undefined)).toBeNull();
    expect(maskDl('   ')).toBeNull();
  });

  test('short values are fully masked (no trailing reveal)', () => {
    expect(maskDl('12')).toBe('••');
    expect(maskDl('X')).toBe('•');
    expect(maskDl('abc')).toBe('•••');
  });

  test('trims surrounding whitespace before masking', () => {
    expect(maskDl('  A1234  ')).toBe('••234'); // "A1234" → 5 chars, last 3 shown
  });
});
