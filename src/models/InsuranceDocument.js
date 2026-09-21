const path = require('path');
const fs   = require('fs');
const db   = require('../config/database');

const TABLE = 'insurance_documents';

// On-disk store for uploaded bytes. data/ is a persistent, gitignored volume
// (see the migration), so files survive redeploys and never enter git.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'insurance-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* created lazily on first write otherwise */ }

// Shared WHERE clause for the documents list + its count so the two never drift.
// `search` matches the file name OR the cab number (case-insensitive substring).
function applyDocFilters(q, { policyId, search } = {}) {
  if (policyId) q.where('policy_id', policyId);
  if (search) {
    q.where((b) => {
      b.whereILike('original_name', `%${search}%`)
       .orWhereILike('cab_number', `%${search}%`);
    });
  }
}

class InsuranceDocument {
  static get UPLOAD_DIR() { return UPLOAD_DIR; }

  /** Absolute path for a stored file. stored_name is app-generated (no traversal). */
  static absPath(storedName) {
    return path.join(UPLOAD_DIR, path.basename(storedName));
  }

  /** Insert one metadata row per uploaded file; returns the created rows. */
  static async createMany(rows) {
    if (!rows.length) return [];
    return db(TABLE).insert(rows).returning('*');
  }

  static list({ policyId, search, limit = 100, offset = 0 } = {}) {
    return db(TABLE)
      .modify((q) => applyDocFilters(q, { policyId, search }))
      .select('id', 'original_name', 'cab_number', 'mime_type', 'size_bytes', 'description', 'uploaded_by', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
  }

  static count({ policyId, search } = {}) {
    return db(TABLE)
      .modify((q) => applyDocFilters(q, { policyId, search }))
      .count('* as count')
      .first();
  }

  static findById(id) {
    return db(TABLE).where({ id }).first();
  }

  /** Delete the DB row and return it (so the caller can unlink the file). */
  static async deleteById(id) {
    const row = await this.findById(id);
    if (!row) return null;
    await db(TABLE).where({ id }).del();
    return row;
  }
}

module.exports = InsuranceDocument;
