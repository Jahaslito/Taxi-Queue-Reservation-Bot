/**
 * Trigram (pg_trgm) GIN indexes for the Documents search.
 *
 * The documents list searches with a leading-wildcard ILIKE
 * (`original_name ILIKE '%term%' OR cab_number ILIKE '%term%'`), which a plain
 * btree index cannot serve — it falls back to a sequential scan. A GIN index
 * with `gin_trgm_ops` makes those substring searches index-backed, so search
 * stays fast as the table grows (the planner still prefers a seq scan on tiny
 * tables, which is correct; the index kicks in once the table is large enough
 * and for search terms of ≥3 characters).
 *
 * The plain btree on `cab_number` (from ...0002) is kept for exact-match/order
 * use; this adds the trigram index alongside it for substring search.
 */
exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS insurance_documents_original_name_trgm ' +
    'ON insurance_documents USING gin (original_name gin_trgm_ops)',
  );
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS insurance_documents_cab_number_trgm ' +
    'ON insurance_documents USING gin (cab_number gin_trgm_ops)',
  );
};

exports.down = async function (knex) {
  // Drop the indexes only; leave the pg_trgm extension in place (other objects
  // may come to depend on it, and re-running up is idempotent).
  await knex.raw('DROP INDEX IF EXISTS insurance_documents_original_name_trgm');
  await knex.raw('DROP INDEX IF EXISTS insurance_documents_cab_number_trgm');
};
