const db = require('../config/database');

const TABLE = 'insurance_claims';

class InsuranceClaim {
  /** Claims joined to their driver's name/company (scoped to the policy). */
  static list({ policyId, limit = 100, offset = 0 } = {}) {
    return db(`${TABLE} as c`)
      .leftJoin('insured_drivers as dr', 'dr.id', 'c.insured_driver_id')
      .modify((q) => { if (policyId) q.where('dr.policy_id', policyId); })
      .select(
        'c.id', 'c.cab_number', 'c.claim_number', 'c.date_of_loss', 'c.description',
        'dr.first_name', 'dr.last_name', 'dr.company',
      )
      .orderBy('c.date_of_loss', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static count({ policyId } = {}) {
    return db(`${TABLE} as c`)
      .leftJoin('insured_drivers as dr', 'dr.id', 'c.insured_driver_id')
      .modify((q) => { if (policyId) q.where('dr.policy_id', policyId); })
      .count('c.id as count')
      .first();
  }
}

module.exports = InsuranceClaim;
