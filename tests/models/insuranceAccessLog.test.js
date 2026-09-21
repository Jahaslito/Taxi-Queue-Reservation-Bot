/**
 * InsuranceAccessLog.record — writes one audit row per PII (DL) reveal, and
 * NEVER throws: an audit-write failure must not break the reveal it records
 * (same posture as DriverAudit). Run: npx jest tests/models/insuranceAccessLog.test.js
 */
jest.mock('../../src/config/database', () => {
  const insert = jest.fn(async () => {});
  const dbMock = jest.fn(() => ({ insert }));
  dbMock._insert = insert;
  return dbMock;
});

const db = require('../../src/config/database');
const InsuranceAccessLog = require('../../src/models/InsuranceAccessLog');

afterEach(() => jest.clearAllMocks());

describe('InsuranceAccessLog.record', () => {
  test('writes the expected row and returns true', async () => {
    const ok = await InsuranceAccessLog.record({
      adminId: 7, action: 'reveal_dl', entity: 'insured_driver',
      entityId: 42, detail: 'dl_number', ip: '10.0.0.1',
    });
    expect(ok).toBe(true);
    expect(db._insert).toHaveBeenCalledWith({
      admin_id: 7, action: 'reveal_dl', entity: 'insured_driver',
      entity_id: 42, detail: 'dl_number', ip: '10.0.0.1',
    });
  });

  test('nullifies missing optional fields', async () => {
    await InsuranceAccessLog.record({ action: 'reveal_dl', entity: 'endorsement' });
    expect(db._insert).toHaveBeenCalledWith(expect.objectContaining({
      admin_id: null, entity_id: null, detail: null, ip: null,
    }));
  });

  test('truncates an over-long IP to 64 chars', async () => {
    await InsuranceAccessLog.record({ action: 'reveal_dl', entity: 'insured_driver', ip: 'x'.repeat(200) });
    expect(db._insert.mock.calls[0][0].ip).toHaveLength(64);
  });

  test('a DB failure is swallowed — returns false, never throws', async () => {
    db._insert.mockRejectedValueOnce(new Error('connection refused'));
    await expect(InsuranceAccessLog.record({ action: 'reveal_dl', entity: 'insured_driver' }))
      .resolves.toBe(false);
  });
});
