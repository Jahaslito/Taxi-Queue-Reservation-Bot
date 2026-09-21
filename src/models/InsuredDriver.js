const db = require('../config/database');

const TABLE = 'insured_drivers';

// Shared filter clause for the driver list + its count. Aliased `dr`.
function applyDriverFilters(q, { search, needsMedical, noDriver, missingDob, policyId } = {}) {
  if (policyId)     q.where('dr.policy_id', policyId);
  if (needsMedical) q.where('dr.needs_medical', true);
  if (noDriver)     q.where('dr.no_driver_assigned', true);
  if (missingDob)   q.whereNull('dr.dob');
  if (search) {
    q.where((b) => {
      b.whereILike('dr.first_name', `%${search}%`)
        .orWhereILike('dr.last_name', `%${search}%`)
        .orWhereILike('dr.cab_number', `%${search}%`)
        .orWhereILike('dr.company', `%${search}%`)
        .orWhereRaw("(COALESCE(dr.first_name,'') || ' ' || COALESCE(dr.last_name,'')) ILIKE ?", [`%${search}%`]);
    });
  }
}

class InsuredDriver {
  static search({ search, needsMedical, noDriver, missingDob, policyId, limit = 50, offset = 0 } = {}) {
    return db(`${TABLE} as dr`)
      .leftJoin('drivers as d', 'd.id', 'dr.driver_id')
      .select(
        'dr.id', 'dr.cab_number', 'dr.company', 'dr.address',
        'dr.first_name', 'dr.last_name', 'dr.dl_number', 'dr.dob',
        'dr.needs_medical', 'dr.no_driver_assigned', 'dr.notes', 'dr.driver_id',
        'd.name as app_driver_name',
        db.raw('(SELECT COUNT(*) FROM insurance_claims c WHERE c.insured_driver_id = dr.id) AS claim_count'),
      )
      .modify((q) => applyDriverFilters(q, { search, needsMedical, noDriver, missingDob, policyId }))
      .orderBy('dr.last_name', 'asc')
      .orderBy('dr.first_name', 'asc')
      .limit(limit)
      .offset(offset);
  }

  static searchCount(filters = {}) {
    return db(`${TABLE} as dr`)
      .modify((q) => applyDriverFilters(q, filters))
      .count('* as count')
      .first();
  }

  /** Full row including the unmasked dl_number — for the audited reveal only. */
  static findByIdWithDl(id) {
    return db(TABLE).where({ id }).first();
  }

  /** Compliance rollups for the overview cards. */
  static async complianceCounts({ policyId } = {}) {
    const scope = (q) => { if (policyId) q.where('policy_id', policyId); };
    const [total, needsMedical, noDriver, missingDl, missingDob, withClaims] = await Promise.all([
      db(TABLE).modify(scope).count('* as c').first(),
      db(TABLE).modify(scope).where('needs_medical', true).count('* as c').first(),
      db(TABLE).modify(scope).where('no_driver_assigned', true).count('* as c').first(),
      db(TABLE).modify(scope).whereNull('dl_number').count('* as c').first(),
      db(TABLE).modify(scope).whereNull('dob').count('* as c').first(),
      db(`${TABLE} as dr`).modify((q) => { if (policyId) q.where('dr.policy_id', policyId); })
        .whereExists(db('insurance_claims as c').whereRaw('c.insured_driver_id = dr.id'))
        .count('* as c').first(),
    ]);
    const n = (r) => parseInt(r.c, 10);
    return {
      total:        n(total),
      needsMedical: n(needsMedical),
      noDriver:     n(noDriver),
      missingDl:    n(missingDl),
      missingDob:   n(missingDob),
      withClaims:   n(withClaims),
    };
  }
}

module.exports = InsuredDriver;
