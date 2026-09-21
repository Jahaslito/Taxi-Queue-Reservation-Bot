const db = require('../config/database');

const TABLE = 'insurance_policies';

class InsurancePolicy {
  /** The live policy the module reports on (the one flagged is_current). */
  static findCurrent() {
    return db(TABLE).where({ is_current: true }).orderBy('effective_date', 'desc').first();
  }

  static findById(id) {
    return db(TABLE).where({ id }).first();
  }

  static all() {
    return db(TABLE).orderBy('effective_date', 'desc');
  }
}

module.exports = InsurancePolicy;
