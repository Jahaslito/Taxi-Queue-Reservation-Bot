// Admin Insurance module (Phase 1 — reporting). All routes sit behind
// authenticateAdmin. Driver's-license numbers are masked in every list
// response; the full value is served only by the reveal endpoints, each of
// which writes an insurance_access_log row.

const fs                   = require('fs');
const InsurancePolicy      = require('../models/InsurancePolicy');
const InsuredVehicle       = require('../models/InsuredVehicle');
const InsuredDriver        = require('../models/InsuredDriver');
const InsuranceClaim       = require('../models/InsuranceClaim');
const InsuranceEndorsement = require('../models/InsuranceEndorsement');
const InsuranceDocument    = require('../models/InsuranceDocument');
const InsuranceAccessLog   = require('../models/InsuranceAccessLog');
const { maskDl }           = require('../utils/pii');

const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/** Whole years between a YYYY-MM-DD (or Date) DOB and today; null if absent. */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// Turn a stored DATE into a plain YYYY-MM-DD. pg returns a `date` column as a
// Date at LOCAL midnight, so format from local components — using toISOString()
// would shift the calendar day by the machine's UTC offset.
const isoDate = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function currentPolicyId() {
  const p = await InsurancePolicy.findCurrent();
  return p ? p.id : null;
}

// ─── Overview dashboard ─────────────────────────────────────────────────────
async function getOverview(req, res, next) {
  try {
    const policy = await InsurancePolicy.findCurrent();
    if (!policy) {
      return res.json({ policy: null, imported: false });
    }
    const policyId = policy.id;

    const [premium, compliance, fleetByMake, growth, links, endorseCount, claimCount] = await Promise.all([
      InsuredVehicle.premiumSummary({ policyId }),
      InsuredDriver.complianceCounts({ policyId }),
      InsuredVehicle.fleetByMake({ policyId }),
      InsuredVehicle.monthlyGrowth({ policyId }),
      InsuredVehicle.appLinkCounts({ policyId }),
      InsuranceEndorsement.searchCount({ policyId }),
      InsuranceClaim.count({ policyId }),
    ]);

    res.json({
      imported: true,
      policy: {
        carrier:             policy.carrier,
        policyNumber:        policy.policy_number,
        effectiveDate:       isoDate(policy.effective_date),
        expirationDate:      isoDate(policy.expiration_date),
        premiumPerVehicle:   policy.premium_per_vehicle != null ? Number(policy.premium_per_vehicle) : null,
      },
      totals: {
        vehiclesOnPolicy: premium.vehicles,
        drivers:          compliance.total,
        endorsements:     parseInt(endorseCount.count, 10),
        claims:           parseInt(claimCount.count, 10),
      },
      premium,
      compliance,
      fleetByMake,
      growth,
      appLinks: links,
    });
  } catch (err) { next(err); }
}

// ─── Vehicles ────────────────────────────────────────────────────────────────
async function listVehicles(req, res, next) {
  try {
    const policyId = await currentPolicyId();
    const { search, company, make, status } = req.query;
    const limit  = Math.min(int(req.query.limit, 50), 200);
    const offset = int(req.query.offset, 0);
    const filters = { search, company, make, status, policyId };

    const [rows, countRow] = await Promise.all([
      InsuredVehicle.search({ ...filters, limit, offset }),
      InsuredVehicle.searchCount(filters),
    ]);

    const vehicles = rows.map((v) => ({
      ...v,
      on_policy_date:  isoDate(v.on_policy_date),
      off_policy_date: isoDate(v.off_policy_date),
      premium:         v.premium != null ? Number(v.premium) : null,
      on_policy:       !v.off_policy_date,
    }));
    res.json({ vehicles, total: parseInt(countRow.count, 10), limit, offset });
  } catch (err) { next(err); }
}

// ─── Drivers (DL masked) ─────────────────────────────────────────────────────
async function listDrivers(req, res, next) {
  try {
    const policyId = await currentPolicyId();
    const { search } = req.query;
    const limit  = Math.min(int(req.query.limit, 50), 200);
    const offset = int(req.query.offset, 0);
    const filters = {
      search,
      needsMedical: req.query.needsMedical === 'true',
      noDriver:     req.query.noDriver === 'true',
      missingDob:   req.query.missingDob === 'true',
      policyId,
    };

    const [rows, countRow] = await Promise.all([
      InsuredDriver.search({ ...filters, limit, offset }),
      InsuredDriver.searchCount(filters),
    ]);

    const drivers = rows.map(({ dl_number, dob, ...rest }) => ({
      ...rest,
      dl_masked:   maskDl(dl_number),
      has_dl:      !!dl_number,
      dob:         isoDate(dob),
      age:         ageFrom(dob),
      claim_count: parseInt(rest.claim_count, 10) || 0,
    }));
    res.json({ drivers, total: parseInt(countRow.count, 10), limit, offset });
  } catch (err) { next(err); }
}

// ─── Claims ──────────────────────────────────────────────────────────────────
async function listClaims(req, res, next) {
  try {
    const policyId = await currentPolicyId();
    const limit  = Math.min(int(req.query.limit, 100), 200);
    const offset = int(req.query.offset, 0);

    const [rows, countRow] = await Promise.all([
      InsuranceClaim.list({ policyId, limit, offset }),
      InsuranceClaim.count({ policyId }),
    ]);
    const claims = rows.map((c) => ({ ...c, date_of_loss: isoDate(c.date_of_loss) }));
    res.json({ claims, total: parseInt(countRow.count, 10), limit, offset });
  } catch (err) { next(err); }
}

// ─── Endorsements (DL masked) ────────────────────────────────────────────────
async function listEndorsements(req, res, next) {
  try {
    const policyId = await currentPolicyId();
    const { search } = req.query;
    const limit  = Math.min(int(req.query.limit, 50), 200);
    const offset = int(req.query.offset, 0);
    const filters = { search, policyId };

    const [rows, countRow] = await Promise.all([
      InsuranceEndorsement.search({ ...filters, limit, offset }),
      InsuranceEndorsement.searchCount(filters),
    ]);
    const endorsements = rows.map(({ dl_number, dob, ...rest }) => ({
      ...rest,
      dl_masked: maskDl(dl_number),
      has_dl:    !!dl_number,
      dob:       isoDate(dob),
      age:       ageFrom(dob),
    }));
    res.json({ endorsements, total: parseInt(countRow.count, 10), limit, offset });
  } catch (err) { next(err); }
}

// ─── Reconciliation (app ↔ policy) ───────────────────────────────────────────
async function getReconciliation(req, res, next) {
  try {
    const policyId = await currentPolicyId();
    const [links, upsell, coverageGap] = await Promise.all([
      InsuredVehicle.appLinkCounts({ policyId }),
      InsuredVehicle.insuredWithoutApp({ policyId }),
      InsuredVehicle.appDriversNotInsured({ policyId }),
    ]);
    res.json({
      summary: {
        linked:            links.linked,
        insuredNotInApp:   upsell.length,
        appNotInsured:     coverageGap.length,
      },
      insuredNotInApp: upsell,        // on policy, not paying app subscribers → upsell
      appNotInsured:   coverageGap,   // active app drivers not on the policy → risk
    });
  } catch (err) { next(err); }
}

// ─── Documents (upload / list / download / preview / delete) ──────────────────
// Only images and PDFs are served inline (preview); everything else is forced
// to download, so an uploaded file can never execute in our origin.
const isPreviewable = (mime) => !!mime && (mime.startsWith('image/') || mime === 'application/pdf');

function docJson(d) {
  return {
    id:            d.id,
    original_name: d.original_name,
    cab_number:    d.cab_number || null,
    mime_type:     d.mime_type || null,
    size_bytes:    d.size_bytes != null ? Number(d.size_bytes) : null,
    description:   d.description || null,
    uploaded_by:   d.uploaded_by ?? null,
    created_at:    d.created_at,
    previewable:   isPreviewable(d.mime_type),
  };
}

// Best-effort removal of files multer already wrote to disk when we reject the
// upload — otherwise a validation failure would leave orphaned bytes behind.
function discardUploadedFiles(files) {
  for (const f of files || []) {
    try { if (f.path) fs.unlinkSync(f.path); } catch { /* already gone */ }
  }
}

// A document can be tagged with ONE cab or SEVERAL (e.g. "Cab #48, #156, #4322").
// Normalise any such entry to a clean, comma-separated, searchable list: split on
// commas / spaces / '#' / ';', drop a stray "Cab" label and empties, keep each
// number exactly as typed (leading zeros intact), de-duplicate, re-join with ", ".
// Returns '' when nothing usable remains (the caller rejects that as missing).
function normalizeCabList(value) {
  const tokens = String(value || '')
    .split(/[\s,;#]+/)
    .map((t) => t.trim())
    .filter((t) => t && !/^cab$/i.test(t));
  return [...new Set(tokens)].join(', ');
}
// Guard rail: a pathological entry returns a clean 400 rather than a DB/index
// error. Comfortably fits a large multi-cab fleet list.
const MAX_CAB_LIST_LEN = 500;

async function uploadDocuments(req, res, next) {
  const files = req.files || [];
  try {
    if (!files.length) {
      const err = new Error('No files were uploaded'); err.statusCode = 400; throw err;
    }

    // A cab number is MANDATORY for every uploaded file. The client sends one
    // `cab_numbers` value per file, in the same order as the files themselves.
    // Each value may be a single cab or a comma-separated list — normalise it.
    const raw = req.body.cab_numbers;
    const cabNumbers = (Array.isArray(raw) ? raw : (raw != null ? [raw] : []))
      .map((c) => normalizeCabList(c));
    if (cabNumbers.length !== files.length || cabNumbers.some((c) => !c)) {
      const err = new Error('Every uploaded file must have a cab number.');
      err.statusCode = 400; throw err;
    }
    if (cabNumbers.some((c) => c.length > MAX_CAB_LIST_LEN)) {
      const err = new Error(`Cab number list is too long (max ${MAX_CAB_LIST_LEN} characters).`);
      err.statusCode = 400; throw err;
    }

    const policyId    = await currentPolicyId();
    const description = (req.body.description || '').trim() || null;
    const rows = files.map((f, i) => ({
      policy_id:     policyId,
      original_name: f.originalname,
      stored_name:   f.filename,     // app-generated by multer (no traversal)
      mime_type:     f.mimetype,
      size_bytes:    f.size,
      cab_number:    cabNumbers[i],
      description,
      uploaded_by:   req.adminId ?? null,
    }));
    const created = await InsuranceDocument.createMany(rows);
    res.status(201).json({ documents: created.map(docJson) });
  } catch (err) {
    discardUploadedFiles(files);   // don't strand bytes on a rejected upload
    next(err);
  }
}

async function listDocuments(req, res, next) {
  try {
    const limit  = Math.min(int(req.query.limit, 100), 200);
    const offset = int(req.query.offset, 0);
    const search = (req.query.search || '').trim() || undefined;
    const [rows, countRow] = await Promise.all([
      InsuranceDocument.list({ search, limit, offset }),
      InsuranceDocument.count({ search }),
    ]);
    res.json({ documents: rows.map(docJson), total: parseInt(countRow.count, 10), limit, offset });
  } catch (err) { next(err); }
}

async function sendDocument(req, res, next, { inline }) {
  try {
    const doc = await InsuranceDocument.findById(req.params.id);
    if (!doc) { const e = new Error('Document not found'); e.statusCode = 404; throw e; }
    const abs = InsuranceDocument.absPath(doc.stored_name);
    if (!fs.existsSync(abs)) { const e = new Error('File is missing on disk'); e.statusCode = 404; throw e; }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Preview only for safe render types; force-download anything else.
    if (inline && isPreviewable(doc.mime_type)) {
      res.setHeader('Content-Type', doc.mime_type);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
      fs.createReadStream(abs).pipe(res);
    } else {
      res.download(abs, doc.original_name);
    }
  } catch (err) { next(err); }
}

const downloadDocument = (req, res, next) => sendDocument(req, res, next, { inline: false });
const previewDocument  = (req, res, next) => sendDocument(req, res, next, { inline: true });

async function deleteDocument(req, res, next) {
  try {
    const doc = await InsuranceDocument.deleteById(req.params.id);
    if (!doc) { const e = new Error('Document not found'); e.statusCode = 404; throw e; }
    try { fs.unlinkSync(InsuranceDocument.absPath(doc.stored_name)); } catch { /* already gone — DB row is what matters */ }
    await InsuranceAccessLog.record({
      adminId: req.adminId, action: 'delete_document', entity: 'insurance_document',
      entityId: Number(req.params.id), detail: doc.original_name, ip: req.ip,
    });
    res.json({ ok: true, id: doc.id });
  } catch (err) { next(err); }
}

// ─── DL reveal (audited) ─────────────────────────────────────────────────────
function makeReveal(model, entity) {
  return async function revealDl(req, res, next) {
    try {
      const row = await model.findByIdWithDl(req.params.id);
      if (!row) {
        const err = new Error('Record not found');
        err.statusCode = 404;
        throw err;
      }
      await InsuranceAccessLog.record({
        adminId:  req.adminId,
        action:   'reveal_dl',
        entity,
        entityId: Number(req.params.id),
        detail:   'dl_number',
        ip:       req.ip,
      });
      res.json({ id: row.id, dl_number: row.dl_number || null });
    } catch (err) { next(err); }
  };
}

module.exports = {
  getOverview,
  listVehicles,
  listDrivers,
  listClaims,
  listEndorsements,
  getReconciliation,
  uploadDocuments,
  listDocuments,
  downloadDocument,
  previewDocument,
  deleteDocument,
  revealDriverDl:      makeReveal(InsuredDriver, 'insured_driver'),
  revealEndorsementDl: makeReveal(InsuranceEndorsement, 'endorsement'),
};
