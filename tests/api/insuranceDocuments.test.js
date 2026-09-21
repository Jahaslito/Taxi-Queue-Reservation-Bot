/**
 * Integration tests — Insurance → Documents (upload / list / download / preview
 * / delete). Pins: admin-only; multi-file upload; unsupported types rejected;
 * download restores the original name; preview inlines images but not text;
 * delete removes the row + the file on disk and writes an audit row.
 *
 * Run independently: npx jest tests/api/insuranceDocuments.test.js
 */
const fs        = require('fs');
const request   = require('supertest');
const createApp = require('../helpers/createApp');
const { db, migrateUp, truncateAll } = require('../helpers/db');
const { createAdmin, adminCookie } = require('../helpers/fixtures');
const InsuranceDocument = require('../../src/models/InsuranceDocument');

const app = createApp();

async function cleanupDocs() {
  const rows = await db('insurance_documents');
  for (const r of rows) { try { fs.unlinkSync(InsuranceDocument.absPath(r.stored_name)); } catch { /* gone */ } }
  await db.raw('TRUNCATE TABLE insurance_documents, insurance_access_log RESTART IDENTITY CASCADE');
}

beforeAll(async () => { await migrateUp(); });
afterEach(async () => { await cleanupDocs(); await truncateAll(); });

const PDF = Buffer.from('%PDF-1.4 fake pdf bytes');
const PNG = Buffer.from('\x89PNG\r\n\x1a\n fake png bytes', 'binary');

describe('Insurance documents', () => {
  test('list and upload require admin auth', async () => {
    expect((await request(app).get('/api/admin/insurance/documents')).status).toBe(401);
    expect((await request(app).post('/api/admin/insurance/documents')).status).toBe(401);
  });

  test('uploads multiple files, then lists them', async () => {
    const admin = await createAdmin();
    const up = await request(app)
      .post('/api/admin/insurance/documents')
      .set('Cookie', adminCookie(admin.id))
      .field('description', 'Q3 certs')
      .field('cab_numbers', '101')
      .field('cab_numbers', '202')
      .attach('files', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' })
      .attach('files', PNG, { filename: 'card.png', contentType: 'image/png' });

    expect(up.status).toBe(201);
    expect(up.body.documents).toHaveLength(2);

    const list = await request(app).get('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id));
    expect(list.body.total).toBe(2);
    const names = list.body.documents.map(d => d.original_name).sort();
    expect(names).toEqual(['card.png', 'policy.pdf']);
    // Each file is tagged with the cab number it was uploaded under.
    expect(list.body.documents.find(d => d.original_name === 'policy.pdf').cab_number).toBe('101');
    expect(list.body.documents.find(d => d.original_name === 'card.png').cab_number).toBe('202');
    expect(list.body.documents.find(d => d.original_name === 'policy.pdf').previewable).toBe(true);
  });

  test('rejects an upload with no cab number (mandatory)', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post('/api/admin/insurance/documents')
      .set('Cookie', adminCookie(admin.id))
      .attach('files', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cab number/i);
    // Nothing persisted (and the controller discards the orphaned bytes).
    expect(await db('insurance_documents').count('* as c').first()).toMatchObject({ c: '0' });
  });

  test('rejects when only some files have a cab number', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post('/api/admin/insurance/documents')
      .set('Cookie', adminCookie(admin.id))
      .field('cab_numbers', '101')
      .attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })
      .attach('files', PNG, { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(await db('insurance_documents').count('* as c').first()).toMatchObject({ c: '0' });
  });

  test('rejects an unsupported file type', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post('/api/admin/insurance/documents')
      .set('Cookie', adminCookie(admin.id))
      .attach('files', Buffer.from('MZ...'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(await db('insurance_documents').count('* as c').first()).toMatchObject({ c: '0' });
  });

  test('download restores the original filename as an attachment', async () => {
    const admin = await createAdmin();
    const up = await request(app).post('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))
      .field('cab_numbers', '303')
      .attach('files', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' });
    const id = up.body.documents[0].id;

    const dl = await request(app).get(`/api/admin/insurance/documents/${id}/download`).set('Cookie', adminCookie(admin.id));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['content-disposition']).toContain('policy.pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  test('preview inlines an image but forces-download a text file', async () => {
    const admin = await createAdmin();
    const up = await request(app).post('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))
      .field('cab_numbers', '404')
      .field('cab_numbers', '505')
      .attach('files', PNG, { filename: 'card.png', contentType: 'image/png' })
      .attach('files', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
    const img = up.body.documents.find(d => d.original_name === 'card.png');
    const txt = up.body.documents.find(d => d.original_name === 'notes.txt');

    const imgRes = await request(app).get(`/api/admin/insurance/documents/${img.id}/preview`).set('Cookie', adminCookie(admin.id));
    expect(imgRes.headers['content-type']).toContain('image/png');
    expect(imgRes.headers['content-disposition']).toContain('inline');

    const txtRes = await request(app).get(`/api/admin/insurance/documents/${txt.id}/preview`).set('Cookie', adminCookie(admin.id));
    expect(txtRes.headers['content-disposition']).toContain('attachment'); // not inlined
  });

  test('delete removes the row + file and writes an audit entry', async () => {
    const admin = await createAdmin();
    const up = await request(app).post('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))
      .field('cab_numbers', '606')
      .attach('files', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' });
    const id = up.body.documents[0].id;
    const stored = (await db('insurance_documents').where({ id }).first()).stored_name;
    expect(fs.existsSync(InsuranceDocument.absPath(stored))).toBe(true);

    const del = await request(app).delete(`/api/admin/insurance/documents/${id}`).set('Cookie', adminCookie(admin.id));
    expect(del.status).toBe(200);

    expect(fs.existsSync(InsuranceDocument.absPath(stored))).toBe(false);
    expect((await request(app).get('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))).body.total).toBe(0);
    const audit = await db('insurance_access_log').where({ action: 'delete_document', entity_id: id });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toBe('policy.pdf');
  });

  test('404 when downloading a non-existent document', async () => {
    const admin = await createAdmin();
    const res = await request(app).get('/api/admin/insurance/documents/999999/download').set('Cookie', adminCookie(admin.id));
    expect(res.status).toBe(404);
  });

  test('search filters documents by name and by cab number', async () => {
    const admin = await createAdmin();
    await request(app).post('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))
      .field('cab_numbers', '777').field('cab_numbers', '888')
      .attach('files', PDF, { filename: 'alpha-policy.pdf', contentType: 'application/pdf' })
      .attach('files', PNG, { filename: 'beta-card.png', contentType: 'image/png' });

    const byName = await request(app).get('/api/admin/insurance/documents?search=alpha').set('Cookie', adminCookie(admin.id));
    expect(byName.body.total).toBe(1);
    expect(byName.body.documents[0].original_name).toBe('alpha-policy.pdf');

    const byCab = await request(app).get('/api/admin/insurance/documents?search=888').set('Cookie', adminCookie(admin.id));
    expect(byCab.body.total).toBe(1);
    expect(byCab.body.documents[0].cab_number).toBe('888');

    const none = await request(app).get('/api/admin/insurance/documents?search=zzz').set('Cookie', adminCookie(admin.id));
    expect(none.body.total).toBe(0);
    expect(none.body.documents).toHaveLength(0);
  });

  test('paginates with limit + offset (total reflects the full set)', async () => {
    const admin = await createAdmin();
    for (const [name, cab] of [['a.pdf', '1'], ['b.pdf', '2'], ['c.pdf', '3']]) {
      await request(app).post('/api/admin/insurance/documents').set('Cookie', adminCookie(admin.id))
        .field('cab_numbers', cab).attach('files', PDF, { filename: name, contentType: 'application/pdf' });
    }
    const p1 = await request(app).get('/api/admin/insurance/documents?limit=2&offset=0').set('Cookie', adminCookie(admin.id));
    const p2 = await request(app).get('/api/admin/insurance/documents?limit=2&offset=2').set('Cookie', adminCookie(admin.id));
    expect(p1.body.total).toBe(3);
    expect(p1.body.documents).toHaveLength(2);
    expect(p2.body.documents).toHaveLength(1);
    const ids1 = p1.body.documents.map(d => d.id);
    const ids2 = p2.body.documents.map(d => d.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});
