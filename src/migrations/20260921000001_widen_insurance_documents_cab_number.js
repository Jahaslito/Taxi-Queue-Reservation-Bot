/**
 * A document can belong to MORE THAN ONE cab — the operator tags it with a
 * comma-separated list (e.g. "48, 156, 157, 4322"). The original cab_number was
 * varchar(32): it held only a single short cab number and rejected a list with a
 * Postgres 22001 ("value too long for type character varying(32)") error, which
 * surfaced to the UI as a generic 500. Widen it to unbounded text.
 *
 * varchar(32) → text is binary-coercible, so Postgres does NOT rewrite the table
 * and automatically rebuilds the column's dependent indexes (the btree from
 * ...0002 and the pg_trgm GIN from ...0003) — substring search keeps working.
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE insurance_documents ALTER COLUMN cab_number TYPE text');
};

exports.down = async function (knex) {
  // Truncate any multi-cab list to 32 chars first so the narrower type can apply.
  await knex.raw(
    'ALTER TABLE insurance_documents ALTER COLUMN cab_number TYPE varchar(32) USING left(cab_number, 32)',
  );
};
