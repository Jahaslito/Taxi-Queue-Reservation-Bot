const db = require('../config/database');

const TABLE = 'insured_vehicles';

// Shared filter clause for the vehicle list + its matching count so the two
// never drift. status: 'on' = still on the policy (no off-date), 'off' = taken
// off. search matches cab #, company, VIN, make and model.
function applyVehicleFilters(q, { search, company, make, status, policyId } = {}) {
  if (policyId) q.where('policy_id', policyId);
  if (company)  q.where('company', company);
  if (make)     q.where('make', make);
  if (status === 'on')  q.whereNull('off_policy_date');
  if (status === 'off') q.whereNotNull('off_policy_date');
  if (search) {
    q.where((b) => {
      b.whereILike('cab_number', `%${search}%`)
        .orWhereILike('company', `%${search}%`)
        .orWhereILike('vin', `%${search}%`)
        .orWhereILike('make', `%${search}%`)
        .orWhereILike('model', `%${search}%`);
    });
  }
}

class InsuredVehicle {
  static search({ search, company, make, status, policyId, limit = 50, offset = 0 } = {}) {
    return db(`${TABLE} as v`)
      .leftJoin('drivers as d', 'd.id', 'v.driver_id')
      .select(
        'v.id', 'v.cab_number', 'v.company', 'v.year', 'v.make', 'v.model', 'v.vin',
        'v.on_policy_date', 'v.off_policy_date', 'v.premium', 'v.notes', 'v.driver_id',
        'd.name as driver_name',
      )
      .modify((q) => applyVehicleFilters(q, { search, company, make, status, policyId }))
      .orderBy('v.cab_number', 'asc')
      .limit(limit)
      .offset(offset);
  }

  static searchCount(filters = {}) {
    return db(`${TABLE} as v`)
      .modify((q) => applyVehicleFilters(q, filters))
      .count('* as count')
      .first();
  }

  /** Premium exposure for the policy: vehicle count + annual & monthly totals. */
  static async premiumSummary({ policyId } = {}) {
    const row = await db(TABLE)
      .modify((q) => { if (policyId) q.where('policy_id', policyId); })
      .whereNull('off_policy_date')
      .count('* as vehicles')
      .sum('premium as annual')
      .first();
    const vehicles = parseInt(row.vehicles, 10) || 0;
    const annual   = parseFloat(row.annual) || 0;
    return { vehicles, annualTotal: annual, monthlyRunRate: annual / 12 };
  }

  /** Vehicle count grouped by make, most common first (for the composition card). */
  static async fleetByMake({ policyId } = {}) {
    const rows = await db(TABLE)
      .modify((q) => { if (policyId) q.where('policy_id', policyId); })
      .whereNotNull('make')
      .select('make')
      .count('* as count')
      .groupBy('make')
      .orderBy('count', 'desc');
    return rows.map((r) => ({ make: r.make, count: parseInt(r.count, 10) }));
  }

  /**
   * Cumulative vehicles on the policy at the end of each month, derived from
   * on/off-policy dates — powers the "Cumulative Fleet Growth" chart. Flat when
   * every vehicle joined on the same effective date (a single snapshot); it
   * gains shape as vehicles are added/removed over time.
   */
  static async monthlyGrowth({ policyId } = {}) {
    const rows = await db(TABLE)
      .modify((q) => { if (policyId) q.where('policy_id', policyId); })
      .whereNotNull('on_policy_date')
      .select('on_policy_date', 'off_policy_date');
    if (!rows.length) return [];

    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const ons  = rows.map((r) => new Date(r.on_policy_date));
    const start = new Date(Math.min(...ons));
    const end   = new Date();

    const series = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last   = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      const endOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const count = rows.filter((r) => {
        const on  = new Date(r.on_policy_date);
        const off = r.off_policy_date ? new Date(r.off_policy_date) : null;
        return on <= endOfMonth && (!off || off > endOfMonth);
      }).length;
      series.push({ month: ym(cursor), count });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return series;
  }

  // ─── Reconciliation against the app's `drivers` table ────────────────────────

  /** How many on-policy vehicles are matched to an active SanQueue driver. */
  static async appLinkCounts({ policyId } = {}) {
    const [linked, unlinked] = await Promise.all([
      db(TABLE).modify((q) => { if (policyId) q.where('policy_id', policyId); })
        .whereNotNull('driver_id').count('* as c').first(),
      db(TABLE).modify((q) => { if (policyId) q.where('policy_id', policyId); })
        .whereNull('driver_id').whereNull('off_policy_date').count('* as c').first(),
    ]);
    return { linked: parseInt(linked.c, 10), unlinkedOnPolicy: parseInt(unlinked.c, 10) };
  }

  /** On-policy vehicles with no matching app driver — a sales/upsell list. */
  static insuredWithoutApp({ policyId, limit = 500 } = {}) {
    return db(TABLE)
      .modify((q) => { if (policyId) q.where('policy_id', policyId); })
      .whereNull('driver_id')
      .whereNull('off_policy_date')
      .select('cab_number', 'company', 'year', 'make', 'model', 'vin')
      .orderBy('cab_number', 'asc')
      .limit(limit);
  }

  /**
   * Active app drivers whose vehicle_number matches no on-policy vehicle — a
   * coverage-gap risk flag (they're running the bot but aren't on the policy).
   */
  static appDriversNotInsured({ policyId, limit = 500 } = {}) {
    const insured = db(TABLE)
      .modify((q) => { if (policyId) q.where('policy_id', policyId); })
      .whereNull('off_policy_date')
      .whereRaw('TRIM(insured_vehicles.cab_number) = TRIM(d.vehicle_number)')
      .select(db.raw('1'));
    return db('drivers as d')
      .where('d.is_active', true)
      .whereNotExists(insured)
      .select('d.id', 'd.name', 'd.vehicle_number', 'd.email')
      .orderBy('d.vehicle_number', 'asc')
      .limit(limit);
  }
}

module.exports = InsuredVehicle;
