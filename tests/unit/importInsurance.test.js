/**
 * Pure parsing/cleaning helpers used by scripts/import-insurance.js. These are
 * what turn the messy spreadsheet cells (MM/DD/YYYY dates, "$4,056", trailing
 * spaces, impossible DOBs, free-text accident notes) into clean column values.
 * Run: npx jest tests/unit/importInsurance.test.js
 */
const { toISODate, toInt, toDecimal, plausibleDob, parseClaim, clean } = require('../../scripts/import-insurance');

describe('clean', () => {
  test('trims ends; empties → null (inner spacing already normalised in the JSON)', () => {
    expect(clean('  A CONSTANT CAB ')).toBe('A CONSTANT CAB');
    expect(clean('')).toBeNull();
    expect(clean(null)).toBeNull();
  });
});

describe('toISODate', () => {
  test('MM/DD/YYYY → ISO, zero-padded', () => {
    expect(toISODate('09/08/2026')).toBe('2026-09-08');
    expect(toISODate('3/6/2026')).toBe('2026-03-06');
  });
  test('already-ISO passes through; junk → null', () => {
    expect(toISODate('2026-09-08')).toBe('2026-09-08');
    expect(toISODate('not a date')).toBeNull();
    expect(toISODate('')).toBeNull();
  });
});

describe('toInt / toDecimal', () => {
  test('toInt parses ints, tolerates trailing spaces, else null', () => {
    expect(toInt('2015 ')).toBe(2015);
    expect(toInt('')).toBeNull();
    expect(toInt('abc')).toBeNull();
  });
  test('toDecimal strips currency formatting', () => {
    expect(toDecimal('4056')).toBe(4056);
    expect(toDecimal('$4,056.00')).toBe(4056);
    expect(toDecimal(null)).toBeNull();
  });
});

describe('plausibleDob', () => {
  const thisYear = new Date().getFullYear();
  test('keeps realistic adult DOBs', () => {
    expect(plausibleDob('1974-01-01')).toBe('1974-01-01');
    expect(plausibleDob('2003-09-09')).toBe('2003-09-09');
  });
  test('nulls impossible values (data-entry errors)', () => {
    expect(plausibleDob(`${thisYear}-01-25`)).toBeNull(); // e.g. the 2026 typo
    expect(plausibleDob('1899-01-01')).toBeNull();        // before 1920
    expect(plausibleDob(null)).toBeNull();
  });
});

describe('parseClaim', () => {
  test('extracts claim number and date of loss from free text', () => {
    expect(parseClaim('Claim #AGMKN26040001 - DOL 03/16/2026')).toEqual({
      claim_number: 'AGMKN26040001',
      date_of_loss: '2026-03-16',
      description:  'Claim #AGMKN26040001 - DOL 03/16/2026',
      raw:          'Claim #AGMKN26040001 - DOL 03/16/2026',
    });
  });
  test('empty → null', () => {
    expect(parseClaim('')).toBeNull();
    expect(parseClaim(null)).toBeNull();
  });
});
