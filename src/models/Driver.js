const db = require('../config/database');

const TABLE = 'drivers';

// When billing is enforced, the bot must only ever service drivers with a live
// subscription — this mirrors requireSubscription so a driver whose payment
// fails (status → past_due) is dropped from servicing the moment Stripe tells
// us, not just blocked from the app UI. Bypassed entirely when
// BILLING_ENABLED=false (soft-launch / staging), matching the other gates.
const BILLING_ENABLED      = process.env.BILLING_ENABLED !== 'false';
const SERVICEABLE_STATUSES = ['active', 'trialing'];
function gateServiceableStatus(q) {
  if (BILLING_ENABLED) q.whereIn('subscription_status', SERVICEABLE_STATUSES);
}

// Columns safe to return to API consumers (excludes credentials and tokens)
const PUBLIC_FIELDS = [
  'id', 'name', 'phone', 'email', 'san_username',
  'vehicle_number', 'scheduled_time', 'scheduled_days', 'day_schedules',
  'scheduled_position', 'day_positions', 'max_acceptable_position',
  'is_active', 'monitor_enabled', 'notes', 'created_at', 'email_verified_at',
  'manually_removed_at',
  // Subscription
  'stripe_customer_id', 'stripe_subscription_id', 'subscription_status', 'trial_ends_at',
  // Scheduled cancellation date (set while cancel_at_period_end is true) — drives
  // the "access ends on <date>" grace banner.
  'subscription_cancel_at',
  // Card-on-file enforcement deadline (grandfathered cardless cohort)
  'card_required_by',
  // Stripe's reason for the most recent failed charge (cleared on success) —
  // shown on the Payment Required screen so drivers don't retry a bad card blind
  'last_payment_error',
  // SMS opt-in (Telnyx toll-free compliance — must be an explicit per-driver choice)
  'sms_opt_in',
];

class Driver {
  /** Single driver by ID — public fields only */
  static findById(id) {
    return db(TABLE).select(PUBLIC_FIELDS).where({ id }).first();
  }

  /** Single driver by ID — includes hashed app_password and encrypted san_password */
  static findByIdWithCredentials(id) {
    return db(TABLE).where({ id }).first();
  }

  static findByEmail(email) {
    return db(TABLE).whereRaw('LOWER(email) = ?', [email.toLowerCase().trim()]).first();
  }

  static findByVehicleNumber(vehicleNumber) {
    return db(TABLE).where({ vehicle_number: vehicleNumber }).first();
  }

  /** Used by the scheduler — returns all columns so san_password is available for decryption */
  static findActiveByScheduledTime(scheduledTime) {
    return db(TABLE)
      .where({ is_active: true, scheduled_time: scheduledTime })
      .modify(gateServiceableStatus);
  }

  /** Returns all active drivers (all columns) for the new day_schedules-based scheduler */
  static findAllActive() {
    return db(TABLE)
      .select(PUBLIC_FIELDS.concat(['san_password']))
      .where({ is_active: true })
      .modify(gateServiceableStatus);
  }

  /** Returns active drivers with monitor_enabled=true (includes san_password for re-queue) */
  static findAllMonitored() {
    return db(TABLE)
      .select(PUBLIC_FIELDS.concat(['san_password']))
      .where({ is_active: true, monitor_enabled: true })
      .modify(gateServiceableStatus);
  }

  /**
   * Drivers whose add-a-card grace window has expired but who are still active
   * with access — the enforcement sweep deactivates these. We only ever stamp
   * card_required_by on the grandfathered cardless cohort, so the presence of a
   * past deadline is itself the "still owes a card" signal; we additionally
   * require an access-granting status so a driver who self-healed (status moved
   * to past_due/canceled by some other path) isn't touched twice.
   */
  static findCardEnforcementDue() {
    return db(TABLE)
      .select('id', 'name', 'email', 'vehicle_number', 'card_required_by')
      .where({ is_active: true })
      .whereIn('subscription_status', ['active', 'trialing'])
      .whereNotNull('card_required_by')
      .where('card_required_by', '<', db.fn.now());
  }

  static async create(data) {
    const [driver] = await db(TABLE).insert(data).returning(PUBLIC_FIELDS);
    return driver;
  }

  static async update(id, data, trx = db) {
    const [driver] = await trx(TABLE)
      .where({ id })
      .update({ ...data, updated_at: trx.fn.now() })
      .returning(PUBLIC_FIELDS);
    return driver;
  }

  static async deactivate(id) {
    await db(TABLE)
      .where({ id })
      .update({ is_active: false, updated_at: db.fn.now() });
  }

  static count({ activeOnly = false } = {}) {
    return db(TABLE)
      .modify((q) => { if (activeOnly) q.where('is_active', true); })
      .count('* as count')
      .first();
  }

  /**
   * Full-text search across drivers with their latest log status joined.
   * Used by the admin drivers list endpoint.
   */
  static search({ search, activeOnly = false, status, limit = 25, offset = 0 } = {}) {
    const latestLogSubquery = db('logs')
      .select('id')
      .whereRaw('driver_id = d.id')
      // "LAST RUN" means an actual run — carryover markers (Log.CARRYOVER_MARKER)
      // are midnight bookkeeping, not a run, so they must not become last_status.
      .whereNot('trigger_type', 'carryover_marker')
      .orderBy('triggered_at', 'desc')
      .limit(1);

    return db('drivers as d')
      .select(
        'd.id', 'd.name', 'd.phone', 'd.email', 'd.san_username',
        'd.vehicle_number', 'd.scheduled_time', 'd.scheduled_days', 'd.day_schedules',
        'd.scheduled_position', 'd.day_positions', 'd.is_active', 'd.notes', 'd.created_at',
        // Billing — lets the admin list derive each driver's payment status
        'd.subscription_status', 'd.stripe_customer_id', 'd.card_required_by',
        'l.status         as last_status',
        'l.queue_position as last_position',
        'l.triggered_at   as last_run',
      )
      .leftJoin('logs as l', 'l.id', latestLogSubquery)
      .modify((q) => {
        if (search) {
          q.where((builder) => {
            builder
              .whereILike('d.name',           `%${search}%`)
              .orWhereILike('d.email',          `%${search}%`)
              .orWhereILike('d.vehicle_number', `%${search}%`)
              .orWhereILike('d.san_username',   `%${search}%`);
          });
        }
        // status: 'active' | 'inactive' filters on is_active; activeOnly kept for back-compat.
        if (status === 'active'   || activeOnly) q.where('d.is_active', true);
        else if (status === 'inactive')          q.where('d.is_active', false);
      })
      .orderBy('d.scheduled_time', 'asc')
      .orderBy('d.name',           'asc')
      .limit(limit)
      .offset(offset);
  }

  /** Count matching drivers — mirrors the filters from search() for pagination totals */
  static searchCount({ search, activeOnly = false, status } = {}) {
    return db('drivers as d')
      .modify((q) => {
        if (search) {
          q.where((builder) => {
            builder
              .whereILike('d.name',           `%${search}%`)
              .orWhereILike('d.email',          `%${search}%`)
              .orWhereILike('d.vehicle_number', `%${search}%`)
              .orWhereILike('d.san_username',   `%${search}%`);
          });
        }
        if (status === 'active'   || activeOnly) q.where('d.is_active', true);
        else if (status === 'inactive')          q.where('d.is_active', false);
      })
      .count('* as count')
      .first();
  }

  /** Find a driver by their Stripe customer ID */
  static findByStripeCustomerId(stripeCustomerId) {
    return db(TABLE).select(PUBLIC_FIELDS).where({ stripe_customer_id: stripeCustomerId }).first();
  }

  /** Find a driver by their email verification token (includes token columns) */
  static findByVerificationToken(token) {
    return db(TABLE)
      .where({ email_verification_token: token })
      .first();
  }

  /** Find a driver by their password reset token (includes token columns) */
  static findByResetToken(token) {
    return db(TABLE)
      .where({ password_reset_token: token })
      .first();
  }

  /**
   * Lean recipient list for admin broadcasts — active drivers only, with just
   * the fields the fan-out needs (id for push targeting, phone for SMS, name +
   * vehicle for any future per-driver personalization). Omitting driverIds (or
   * passing an empty array) returns every active driver = a blast.
   */
  static listForBroadcast({ driverIds } = {}) {
    return db(TABLE)
      .select('id', 'name', 'phone', 'vehicle_number')
      .where({ is_active: true })
      // Canceled / past_due drivers keep is_active=true so they can log in and
      // resubscribe, but they must not receive broadcasts — even when
      // explicitly targeted by ID.
      .modify(gateServiceableStatus)
      .modify((q) => {
        if (driverIds && driverIds.length) q.whereIn('id', driverIds);
      });
  }

  /** Counts active drivers grouped by scheduled_time for the overview dashboard */
  static scheduleBreakdown() {
    return db(TABLE)
      .select('scheduled_time')
      .count('* as count')
      .where('is_active', true)
      // Only serviceable drivers — canceled/past_due drivers won't be run, so
      // counting them would overstate scheduled capacity.
      .modify(gateServiceableStatus)
      .groupBy('scheduled_time')
      .orderBy('scheduled_time', 'asc');
  }
}

module.exports = Driver;
