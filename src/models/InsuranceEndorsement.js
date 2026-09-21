const db = require('../config/database');

const TABLE = 'insurance_endorsements';

function applyEndorsementFilters(q, { search, added, policyId } = {}) {
  if (policyId) q.where('policy_id', policyId);
  if (added === true)  q.where('added', true);
  if (added === false) q.where('added', false);
  if (search) {
    q.where((b) => {
      b.whereILike('cab_number', `%${search}%`)
        .orWhereILike('company', `%${search}%`)
        .orWhereILike('first_name', `%${search}%`)
        .orWhereILike('last_name', `%${search}%`)
        .orWhereILike('endorsement_text', `%${search}%`);
    });
  }
}

class InsuranceEndorsement {
  static search({ search, added, policyId, limit = 50, offset = 0 } = {}) {
    return db(TABLE)
      .select(
        'id', 'cab_number', 'company', 'first_name', 'last_name',
        'dl_number', 'dob', 'endorsement_text', 'added',
      )
      .modify((q) => applyEndorsementFilters(q, { search, added, policyId }))
      .orderBy('cab_number', 'asc')
      .limit(limit)
      .offset(offset);
  }

  static searchCount(filters = {}) {
    return db(TABLE)
      .modify((q) => applyEndorsementFilters(q, filters))
      .count('* as count')
      .first();
  }

  static findByIdWithDl(id) {
    return db(TABLE).where({ id }).first();
  }
}

module.exports = InsuranceEndorsement;
