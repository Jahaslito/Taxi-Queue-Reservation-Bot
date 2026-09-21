/**
 * Integration tests — Insurance module (admin, read-only + audited DL reveal).
 *
 * Pins the security-critical behaviour: routes require admin auth, list
 * responses NEVER leak a raw DL (masked only), and every full-DL reveal writes
 * an insurance_access_log row.
 *
 * Run independently: npx jest tests/api/insurance.test.js
 */
const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll } = require('../helpers/db');
const { createAdmin, adminCookie } = require('../helpers/fixtures');

const app = createApp();

// insurance_policies / _endorsements aren't reached by truncateAll's CASCADE
// (they don't FK to drivers), so clear the whole insurance schema ourselves.
async function truncateInsurance() {
  await db.raw('TRUNCATE TABLE insurance_access_log, insurance_claims, insurance_endorsements, insured_drivers, insured_vehicles, insurance_policies RESTART IDENTITY CASCADE');
}

async function seed() {
  const [policy] = await db('insurance_policies').insert({
    carrier: 'Incline Americas Insurance Company',
    policy_number: 'IA2026TLP00673',
    effective_date: '2026-09-08',
    premium_per_vehicle: 4056,
    is_current: true,
  }).returning('id');
  const policyId = policy.id ?? policy;

  await db('insured_vehicles').insert([
    { policy_id: policyId, vin: 'VIN0001', cab_number: '81',  company: 'CA CAB', year: 2015, make: 'Toyota', model: 'Prius', on_policy_date: '2026-09-08', premium: 4056 },
    { policy_id: policyId, vin: 'VIN0002', cab_number: '281', company: 'CA CAB', year: 2024, make: 'Toyota', model: 'Prius', on_policy_date: '2026-09-08', off_policy_date: '2026-09-15', premium: 4056 },
    { policy_id: policyId, vin: 'VIN0003', cab_number: '89',  company: 'YEHA CAB', year: 2012, make: 'Honda', model: 'Civic', on_policy_date: '2026-09-08', premium: 4056 },
  ]);

  const [d1] = await db('insured_drivers').insert({
    policy_id: policyId, cab_number: '81', company: 'CA CAB',
    first_name: 'Fekada', last_name: 'Hitaha', dl_number: 'B3057946', dob: '1974-01-01',
  }).returning('id');
  await db('insured_drivers').insert([
    { policy_id: policyId, cab_number: '156', company: 'A CONSTANT CAB', first_name: 'Alfredo', last_name: 'Perez', dl_number: 'A3211435', needs_medical: true },
    { policy_id: policyId, cab_number: '4324', company: 'A CONSTANT CAB', no_driver_assigned: true },
  ]);
  const insuredDriverId = d1.id ?? d1;

  await db('insurance_claims').insert({
    insured_driver_id: insuredDriverId, cab_number: '81',
    claim_number: 'AGMKN26040001', date_of_loss: '2026-03-16', description: 'rear-end',
  });
  await db('insurance_endorsements').insert({
    policy_id: policyId, cab_number: '81', first_name: 'Mahad', last_name: 'Hassan',
    dl_number: 'F4500661', endorsement_text: 'add driver',
  });

  return { policyId, insuredDriverId };
}

beforeAll(async () => { await migrateUp(); });
afterEach(async () => { await truncateInsurance(); await truncateAll(); });

describe('GET /api/admin/insurance/*', () => {
  test('every endpoint requires admin auth', async () => {
    for (const path of ['overview', 'vehicles', 'drivers', 'claims', 'endorsements', 'reconciliation']) {
      const res = await request(app).get(`/api/admin/insurance/${path}`);
      expect(res.status).toBe(401);
    }
  });

  test('overview returns policy header + totals + compliance', async () => {
    await seed();
    const admin = await createAdmin();
    const res = await request(app).get('/api/admin/insurance/overview').set('Cookie', adminCookie(admin.id));

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(true);
    expect(res.body.policy.policyNumber).toBe('IA2026TLP00673');
    expect(res.body.totals.vehiclesOnPolicy).toBe(2);   // 3 seeded, 1 off-policy
    expect(res.body.totals.drivers).toBe(3);
    expect(res.body.totals.claims).toBe(1);
    expect(res.body.compliance.needsMedical).toBe(1);
    expect(res.body.compliance.noDriver).toBe(1);
    expect(res.body.premium.annualTotal).toBe(8112);    // 2 on-policy × 4056
  });

  test('overview reports not-imported on an empty DB', async () => {
    const admin = await createAdmin();
    const res = await request(app).get('/api/admin/insurance/overview').set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(false);
    expect(res.body.policy).toBeNull();
  });

  test('driver list masks the DL and never returns the raw value', async () => {
    await seed();
    const admin = await createAdmin();
    const res = await request(app).get('/api/admin/insurance/drivers').set('Cookie', adminCookie(admin.id));

    expect(res.status).toBe(200);
    const withDl = res.body.drivers.find(d => d.cab_number === '81');
    expect(withDl.dl_masked).toBe('•••••946');
    expect(withDl.dl_number).toBeUndefined();     // raw DL must never appear in a list
    expect(withDl.age).toBeGreaterThan(40);       // derived from 1974 DOB
    expect(JSON.stringify(res.body)).not.toContain('B3057946');
  });

  test('vehicle status filter separates on/off policy', async () => {
    await seed();
    const admin = await createAdmin();
    const on  = await request(app).get('/api/admin/insurance/vehicles?status=on').set('Cookie', adminCookie(admin.id));
    const off = await request(app).get('/api/admin/insurance/vehicles?status=off').set('Cookie', adminCookie(admin.id));
    expect(on.body.total).toBe(2);
    expect(off.body.total).toBe(1);
    expect(off.body.vehicles[0].cab_number).toBe('281');
  });

  test('an empty status param is treated as "all" (not a validation error)', async () => {
    await seed();
    const admin = await createAdmin();
    const res = await request(app).get('/api/admin/insurance/vehicles?status=').set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);   // all seeded vehicles, on + off
  });
});

describe('POST /api/admin/insurance/drivers/:id/reveal-dl', () => {
  test('returns the full DL and writes an audit row', async () => {
    const { insuredDriverId } = await seed();
    const admin = await createAdmin();
    const res = await request(app)
      .post(`/api/admin/insurance/drivers/${insuredDriverId}/reveal-dl`)
      .set('Cookie', adminCookie(admin.id));

    expect(res.status).toBe(200);
    expect(res.body.dl_number).toBe('B3057946');

    const audit = await db('insurance_access_log').where({ entity: 'insured_driver', entity_id: insuredDriverId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'reveal_dl', admin_id: admin.id, detail: 'dl_number' });
  });

  test('404 for a non-existent record', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post('/api/admin/insurance/drivers/999999/reveal-dl')
      .set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(404);
  });
});
