#!/usr/bin/env node
// Import the fleet-insurance roster (UNITED TAXI WORKERS OF SAN DIEGO
// spreadsheet, pre-cleaned to data/insurance/insurance_all.json) into the
// insurance_* tables that back the admin Insurance module.
//
// FULL-SHEET REFRESH + IDEMPOTENT: everything runs in one transaction that
// first wipes the current policy's rows, then re-inserts from the JSON, so
// re-running never duplicates. Vehicle→app-driver links are resolved here by
// matching cab_number → drivers.vehicle_number (unique).
//
// ─── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/import-insurance.js                 # APPLY (commit) + summary
//   node scripts/import-insurance.js --dry-run       # do everything, then ROLL BACK
//   node scripts/import-insurance.js path/to.json    # import a different export
//
// The JSON is produced from the .xlsx (Phase 2 will add an in-app upload); its
// shape is { policy, vehicles[], drivers[], endorsements[] }.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../src/config/database');

const DRY_RUN   = process.argv.includes('--dry-run');
const JSON_PATH = process.argv.slice(2).find((a) => !a.startsWith('--'))
  || path.join(__dirname, '..', 'data', 'insurance', 'insurance_all.json');

// ─── Parsing helpers ──────────────────────────────────────────────────────────
const clean = (v) => (v == null ? null : String(v).trim() || null);

/** "MM/DD/YYYY" (or already-ISO) → "YYYY-MM-DD", else null. */
function toISODate(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function toInt(v) {
  const n = parseInt(clean(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toDecimal(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const CURRENT_YEAR = new Date().getFullYear();
/**
 * Guard against the data-entry errors in the sheet (e.g. a DOB of 2026-01-25).
 * A licensed driver can't be under 16 or born before 1920 — such values are
 * imported as null so they never poison an age calc, and counted in the report.
 */
function plausibleDob(iso) {
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  if (year < 1920 || year > CURRENT_YEAR - 16) return null;
  return iso;
}

/** Best-effort claim-number + date-of-loss out of a free-text ACCIDENTS cell. */
function parseClaim(raw) {
  const s = clean(raw);
  if (!s) return null;
  const num  = s.match(/claim\s*#?\s*([A-Za-z0-9-]+)/i);
  const date = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  return {
    claim_number: num ? num[1] : null,
    date_of_loss: date ? toISODate(date[1]) : null,
    description:  s,
    raw:          s,
  };
}

async function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`✗ Data file not found: ${JSON_PATH}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const { policy, vehicles = [], drivers = [], endorsements = [] } = data;
  if (!policy || !policy.policy_number) {
    console.error('✗ JSON is missing a policy with a policy_number');
    process.exit(1);
  }

  console.log(`\n📄 ${JSON_PATH}`);
  console.log(`   policy ${policy.policy_number} — ${policy.carrier}`);
  console.log(`   ${vehicles.length} vehicles · ${drivers.length} drivers · ${endorsements.length} endorsements`);
  console.log(DRY_RUN ? '   MODE: dry-run (will roll back)\n' : '   MODE: apply (will commit)\n');

  const stats = {
    vehLinked: 0, drvLinked: 0, dobNulled: 0, claims: 0, needsMedical: 0, noDriver: 0,
  };

  await db.transaction(async (trx) => {
    // ── Policy upsert (by policy_number); mark it the current one ──────────────
    await trx('insurance_policies').update({ is_current: false });
    const existing = await trx('insurance_policies')
      .where({ policy_number: policy.policy_number }).first();

    const policyRow = {
      carrier:             policy.carrier,
      policy_number:       policy.policy_number,
      effective_date:      toISODate(policy.effective_date),
      expiration_date:     toISODate(policy.expiration_date),
      premium_per_vehicle: toDecimal(policy.premium_per_vehicle),
      is_current:          true,
      updated_at:          trx.fn.now(),
    };

    let policyId;
    if (existing) {
      await trx('insurance_policies').where({ id: existing.id }).update(policyRow);
      policyId = existing.id;
    } else {
      const [row] = await trx('insurance_policies').insert(policyRow).returning('id');
      policyId = row.id ?? row;
    }

    // ── Wipe this policy's rows (claims cascade off insured_drivers) ───────────
    await trx('insured_drivers').where({ policy_id: policyId }).del();
    await trx('insured_vehicles').where({ policy_id: policyId }).del();
    await trx('insurance_endorsements').where({ policy_id: policyId }).del();

    // ── App-driver link map: drivers.vehicle_number (unique) → drivers.id ──────
    const driverRows = await trx('drivers').select('id', 'vehicle_number');
    const byVehicle  = new Map(
      driverRows
        .filter((d) => d.vehicle_number != null)
        .map((d) => [String(d.vehicle_number).trim(), d.id]),
    );
    const linkFor = (cab) => (cab ? byVehicle.get(String(cab).trim()) ?? null : null);

    // ── Vehicles ───────────────────────────────────────────────────────────────
    for (const v of vehicles) {
      const cab       = clean(v.cab_number);
      const driver_id = linkFor(cab);
      if (driver_id) stats.vehLinked++;
      await trx('insured_vehicles').insert({
        policy_id:       policyId,
        vin:             clean(v.vin),
        cab_number:      cab,
        company:         clean(v.company),
        year:            toInt(v.year),
        make:            clean(v.make),
        model:           clean(v.model),
        on_policy_date:  toISODate(v.on_policy),
        off_policy_date: toISODate(v.off_policy),
        premium:         toDecimal(v.premium_per_vehicle),
        notes:           clean(v.notes),
        driver_id,
      });
    }

    // ── Drivers (+ derived claims) ──────────────────────────────────────────────
    for (const d of drivers) {
      const cab       = clean(d.cab_number);
      const driver_id = linkFor(cab);
      if (driver_id) stats.drvLinked++;

      const rawDob = toISODate(d.dob);
      const dob    = plausibleDob(rawDob);
      if (rawDob && !dob) stats.dobNulled++;

      const needsMedical = /needs medical/i.test(d.notes || '');
      const noDriver     = !!d.no_driver_assigned;
      if (needsMedical) stats.needsMedical++;
      if (noDriver)     stats.noDriver++;

      const [row] = await trx('insured_drivers').insert({
        policy_id:          policyId,
        cab_number:         cab,
        company:            clean(d.company),
        address:            clean(d.address),
        first_name:         clean(d.first_name),
        last_name:          clean(d.last_name),
        dl_number:          clean(d.dl_number),
        dob,
        needs_medical:      needsMedical,
        no_driver_assigned: noDriver,
        notes:              clean(d.notes),
        driver_id,
      }).returning('id');
      const insuredDriverId = row.id ?? row;

      const claim = parseClaim(d.accidents);
      if (claim) {
        stats.claims++;
        await trx('insurance_claims').insert({ insured_driver_id: insuredDriverId, cab_number: cab, ...claim });
      }
    }

    // ── Endorsements ────────────────────────────────────────────────────────────
    for (const e of endorsements) {
      await trx('insurance_endorsements').insert({
        policy_id:        policyId,
        cab_number:       clean(e.cab_number),
        company:          clean(e.company),
        address:          clean(e.address),
        first_name:       clean(e.first_name),
        last_name:        clean(e.last_name),
        dl_number:        clean(e.dl_number),
        dob:              plausibleDob(toISODate(e.dob)),
        endorsement_text: clean(e.endorsements),
        added:            false,
      });
    }

    if (DRY_RUN) throw new Error('__ROLLBACK__'); // abort the tx without committing
  }).catch((err) => {
    if (err.message === '__ROLLBACK__') return;   // expected in dry-run
    throw err;
  });

  console.log('   Vehicles inserted:      ', vehicles.length, `(${stats.vehLinked} linked to an app driver)`);
  console.log('   Drivers inserted:       ', drivers.length, `(${stats.drvLinked} linked, ${stats.needsMedical} needs-medical, ${stats.noDriver} no-driver-assigned)`);
  console.log('   Claims parsed:          ', stats.claims);
  console.log('   Endorsements inserted:  ', endorsements.length);
  console.log('   DOBs nulled (implausible):', stats.dobNulled);
  console.log(DRY_RUN ? '\n↩  Dry-run — rolled back, nothing written.\n' : '\n✓ Import committed.\n');
}

// Pure helpers exported for unit tests; the import only runs when invoked
// directly (node scripts/import-insurance.js), never on require().
module.exports = { toISODate, toInt, toDecimal, plausibleDob, parseClaim, clean };

if (require.main === module) {
  main()
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error('\n✗ Import failed:', err.message);
      await db.destroy();
      process.exit(1);
    });
}
