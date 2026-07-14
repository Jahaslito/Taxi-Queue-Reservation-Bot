/**
 * DriverAudit.recordChanges — field diff + secret masking.
 *
 * The audit exists so a cab handover (2026-07-13: vehicle_number and SAN
 * credentials moved between records over two days) is answerable from the DB
 * instead of nginx/log archaeology. These tests pin:
 *   1. one row per REALLY-changed field — unchanged, re-sent values are skipped;
 *   2. secrets (san_password, app_password) never store material, only markers;
 *   3. null/'' equivalence doesn't produce phantom rows;
 *   4. a DB failure is swallowed (audit must never break the save).
 *
 * Run: npx jest tests/models/driverAudit.test.js
 */

jest.mock('../../src/config/database', () => {
  const insert = jest.fn(async () => {});
  const dbMock = jest.fn(() => ({ insert }));
  dbMock._insert = insert;
  return dbMock;
});

const db          = require('../../src/config/database');
const DriverAudit = require('../../src/models/DriverAudit');

const before = {
  name:           'Mataan Noor',
  phone:          '555-0100',
  vehicle_number: '0034',
  san_username:   'Lightcab',
  san_password:   'enc:OLDCIPHER',
  app_password:   '$2a$10$oldhash',
  notes:          null,
  is_active:      true,
};

afterEach(() => jest.clearAllMocks());

describe('DriverAudit.recordChanges', () => {
  test('writes one row per changed field, skips unchanged ones', async () => {
    const n = await DriverAudit.recordChanges({
      driverId: 35, driverName: 'Mataan Noor', changedBy: 'admin', adminId: 1,
      before,
      after: {
        name:           'Mataan Noor',   // unchanged — no row
        vehicle_number: '0026',          // changed
        san_username:   'Jamcab26',      // changed
      },
    });

    expect(n).toBe(2);
    const rows = db._insert.mock.calls[0][0];
    expect(rows).toHaveLength(2);

    const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
    expect(byField.vehicle_number).toMatchObject({
      driver_id: 35, changed_by: 'admin', admin_id: 1,
      old_value: '0034', new_value: '0026',
    });
    expect(byField.san_username).toMatchObject({
      old_value: 'Lightcab', new_value: 'Jamcab26',
    });
  });

  test('secrets store markers, never hash/ciphertext material', async () => {
    await DriverAudit.recordChanges({
      driverId: 35, driverName: 'Mataan Noor', changedBy: 'driver',
      before,
      after: { san_password: 'enc:NEWCIPHER', app_password: '$2a$10$newhash' },
    });

    const rows = db._insert.mock.calls[0][0];
    for (const r of rows) {
      expect(r.old_value).toBe('(hidden)');
      expect(r.new_value).toBe('(changed)');
      expect(JSON.stringify(r)).not.toMatch(/CIPHER|\$2a\$10/);
    }
  });

  test("null ↔ '' round-trips produce no phantom rows; boolean flips recorded as text", async () => {
    const n = await DriverAudit.recordChanges({
      driverId: 41, driverName: 'Ali Adde', changedBy: 'admin', adminId: 1,
      before,
      after: { notes: '', is_active: false },
    });

    expect(n).toBe(1); // notes null → '' is NOT a change; is_active true → false is
    const [row] = db._insert.mock.calls[0][0];
    expect(row).toMatchObject({ field: 'is_active', old_value: 'true', new_value: 'false' });
  });

  test('no changes at all → no insert call', async () => {
    const n = await DriverAudit.recordChanges({
      driverId: 35, driverName: 'Mataan Noor', changedBy: 'admin', adminId: 1,
      before,
      after: { name: 'Mataan Noor', vehicle_number: '0034' },
    });
    expect(n).toBe(0);
    expect(db._insert).not.toHaveBeenCalled();
  });

  test('a DB failure is swallowed — the save must never break on auditing', async () => {
    db._insert.mockRejectedValueOnce(new Error('connection refused'));
    await expect(DriverAudit.recordChanges({
      driverId: 35, driverName: 'Mataan Noor', changedBy: 'admin', adminId: 1,
      before,
      after: { vehicle_number: '0187' },
    })).resolves.toBe(0);
  });
});
