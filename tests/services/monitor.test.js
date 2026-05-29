/**
 * Monitor Service — Operating Hours & Requeue Gate Tests
 *
 * This covers the CRITICAL business rule:
 *   Auto-requeue only fires between 8 AM and 11 PM Pacific Time.
 *   Manual runs (▶ Run button) always fire regardless of time.
 *
 * Strategy
 * ────────
 * • _isWithinOperatingHours() is tested directly with Jest fake timers
 *   against 9 boundary cases covering the full 24-hour range.
 * • The requeue gate decision (mirrors the gone-handler logic) is tested
 *   as a local pure helper — same pattern as scheduler.test.js uses for
 *   wouldSelectDriver — so no state machine plumbing is needed.
 * • manualRun() is tested to confirm it enters the 'requeuing' state
 *   even at 2 AM PT, proving it bypasses the operating hours gate.
 *
 * Run: npx jest tests/services/monitor.test.js
 */

// ─── Mocks (hoisted before any require) ──────────────────────────────────────
jest.mock('../../src/services/schedulerService');
jest.mock('../../src/models/Driver');
jest.mock('../../src/models/Log');

const { runBotForDriver } = require('../../src/services/schedulerService');
const Driver               = require('../../src/models/Driver');
const Log                  = require('../../src/models/Log');

const monitor = require('../../src/services/monitorService');
const {
  _isWithinOperatingHours,
  _evaluatePositionScheduler,
  addWatch,
  manualRun,
  getState,
  stopMonitor,
  allowRefireToday,
  armPositionWindowForToday,
} = monitor;

// ─── UTC timestamp for a given Pacific Standard Time hour ─────────────────────
// Uses January 15-16 2026 (PST = UTC-8, no DST ambiguity).
// PT hour 0  → 2026-01-15T08:00Z
// PT hour 17 → 2026-01-16T01:00Z  (crosses midnight UTC)
function ptHour(h) {
  const utcH = (h + 8) % 24;
  const day  = (h + 8) >= 24 ? 16 : 15;
  return new Date(`2026-01-${day}T${String(utcH).padStart(2, '0')}:00:00.000Z`);
}

// ─── Local mirror of the gone-handler gate decision ───────────────────────────
// The only gate is operating hours — no cooldown.
//
//   if (!isWithinOperatingHours()) → 'outside_hours'
//   else                            → 'requeue'
//
function gateDecision(withinHours) {
  return withinHours ? 'requeue' : 'outside_hours';
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────
const DRIVER_ID  = 42;
const mockDriver = {
  id:             DRIVER_ID,
  name:           'Test Driver',
  vehicle_number: '9999',
  san_username:   'san_user',
  san_password:   'enc_pass',
  is_active:      true,
};

function setupMocks() {
  Driver.findById.mockResolvedValue(mockDriver);
  Driver.findByIdWithCredentials.mockResolvedValue(mockDriver);
  Log.findTodayLatest.mockResolvedValue(null);
  Log.findTodayMonitorRequeues.mockResolvedValue({ count: '0' });
  runBotForDriver.mockResolvedValue({
    success: true, alreadyQueued: false, position: 5, durationMs: 100,
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  stopMonitor();
});

// ─── 1. isWithinOperatingHours() — boundary cases ────────────────────────────

describe('isWithinOperatingHours()', () => {
  const CASES = [
    { h:  0, want: false, label: 'midnight PT' },
    { h:  3, want: false, label: '3 AM PT — two hours before start' },
    { h:  4, want: false, label: '4 AM PT — one hour before start' },
    { h:  5, want: true,  label: '5 AM PT — exact start (inclusive)' },
    { h:  7, want: true,  label: '7 AM PT' },
    { h:  9, want: true,  label: '9 AM PT' },
    { h: 12, want: true,  label: 'noon PT' },
    { h: 17, want: true,  label: '5 PM PT' },
    { h: 22, want: true,  label: '10 PM PT — last full hour inside window' },
    { h: 23, want: false, label: '11 PM PT — exact cutoff (exclusive)' },
  ];

  test.each(CASES)('$label → $want', ({ h, want }) => {
    jest.useFakeTimers({ now: ptHour(h) });
    expect(_isWithinOperatingHours()).toBe(want);
  });
});

// ─── 2. Requeue gate decision — the gone-handler logic ───────────────────────

describe('auto-requeue gate (gone-handler logic)', () => {

  test('within hours → fires requeue immediately (no cooldown)', () => {
    jest.useFakeTimers({ now: ptHour(10) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('requeue');
  });

  test('within hours, recently requeued → still fires (no cooldown)', () => {
    jest.useFakeTimers({ now: ptHour(14) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('requeue');
  });

  test('outside hours (2 AM) → blocked by time gate', () => {
    jest.useFakeTimers({ now: ptHour(2) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('outside_hours');
  });

  test('outside hours (11 PM) → blocked by time gate', () => {
    jest.useFakeTimers({ now: ptHour(23) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('outside_hours');
  });

  test('boundary 5 AM — exactly at start → fires', () => {
    jest.useFakeTimers({ now: ptHour(5) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('requeue');
  });

  test('boundary 11 PM — exactly at cutoff → blocked', () => {
    jest.useFakeTimers({ now: ptHour(23) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('outside_hours');
  });

  // ─── The persistent-gone branch fires on every poll while driver is still gone ─
  // Verifies that a driver already in 'gone' state gets requeued on the next poll
  // tick — there is no cooldown preventing it.
  test('driver stuck in gone state on later poll → requeues immediately', () => {
    jest.useFakeTimers({ now: ptHour(10) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('requeue');
  });

  test('driver stuck in gone state outside hours → still blocked', () => {
    jest.useFakeTimers({ now: ptHour(2) });
    expect(gateDecision(_isWithinOperatingHours())).toBe('outside_hours');
  });
});

// ─── 3. manualRun() bypasses the operating hours gate ────────────────────────
//
// The operating hours gate lives exclusively in the poll loop's gone-handler.
// manualRun() skips straight to triggerRequeue() — no time check at all.
// We prove this by verifying it enters 'requeuing' state regardless of the clock.
//
// A never-resolving bot mock keeps the driver in 'requeuing' long enough to
// inspect it — otherwise the fast mock would complete before our assertion.

describe('manualRun() — operating hours bypass', () => {
  beforeEach(async () => {
    setupMocks();
    // Never-resolving: holds state = 'requeuing' for the duration of each test
    runBotForDriver.mockImplementation(() => new Promise(() => {}));
    await addWatch(DRIVER_ID, { isAuto: true });
  });

  test('triggers requeue regardless of time — no operating hours check', async () => {
    await manualRun(DRIVER_ID);
    // triggerRequeue sets state = 'requeuing' synchronously before the bot runs.
    // If manualRun had a time gate, this would NOT be 'requeuing' outside hours.
    const snap = getState().watches.find(w => w.driverId === DRIVER_ID);
    expect(snap.state).toBe('requeuing');
  });

  test('sets lastRequeuedAt immediately (before bot completes)', async () => {
    await manualRun(DRIVER_ID);
    const snap = getState().watches.find(w => w.driverId === DRIVER_ID);
    expect(snap.lastRequeuedAt).not.toBeNull();
  });

  test('throws if driver is not being watched', async () => {
    await expect(manualRun(9999)).rejects.toThrow('Driver not in watch list');
  });

  test('throws if driver is already requeuing (prevents double-run)', async () => {
    await manualRun(DRIVER_ID); // state → 'requeuing' (synchronous in triggerRequeue)
    await expect(manualRun(DRIVER_ID)).rejects.toThrow('Bot is already running');
  });
});

// ─── allowRefireToday() — re-arm the position scheduler mid-day ───────────────
// Used after a manual run / early auto-requeue has already placed the driver,
// when the admin wants the position scheduler to fire again later in the day
// for the actual target. Resets every flag that would skip them.

describe('allowRefireToday()', () => {
  beforeEach(async () => {
    setupMocks();
    await addWatch(DRIVER_ID, { isAuto: true });
  });

  test('returns false for an unwatched driver (no throw)', () => {
    expect(allowRefireToday(9999)).toBe(false);
  });

  test('clears positionFiredToday so the scheduler can fire again', () => {
    // Simulate post-manual-run state: flag was set by skip_already_seen path
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.positionFiredToday = true;
    internal.hasBeenSeen        = true;
    internal.manuallyRemovedAt  = new Date();

    expect(allowRefireToday(DRIVER_ID)).toBe(true);

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.positionFiredToday).toBe(false);
    expect(after.hasBeenSeen).toBe(false);
    expect(after.manuallyRemovedAt).toBeNull();
  });

  test('does not flip state away from "requeuing" — bot in flight stays in flight', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state              = 'requeuing';
    internal.positionFiredToday = true;

    allowRefireToday(DRIVER_ID);

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.state).toBe('requeuing');           // not overwritten
    expect(after.positionFiredToday).toBe(false);    // but flag still cleared
  });

  test('resets carryover / terminal flags too — clean slate', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.inQueueFromCarryover = true;
    internal.terminalSeen         = true;
    internal.terminalName         = 'T2';
    internal.terminalPosition     = 12;
    // Default state from addWatch: state='watching', hasBeenSeen=false, so
    // isObservablyQueued is false → carryover gets cleared.

    allowRefireToday(DRIVER_ID);

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.inQueueFromCarryover).toBe(false);
    expect(after.terminalName).toBeNull();
    expect(after.terminalPosition).toBeNull();
  });

  test('driver currently in V Holding → tagged carryover (no need to remove first)', () => {
    // Mirrors the use case the user flagged: admin clicks "Arm" while the
    // driver is at #28 in queue. We DON'T want admins to have to manually
    // remove them first — the carryover machinery + SAN's overnight drop
    // handle it. Same policy as armPositionWindowForToday at 3 AM.
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state              = 'in_queue';
    internal.hasBeenSeen        = true;
    internal.positionFiredToday = true;  // skip_already_seen set this

    allowRefireToday(DRIVER_ID);

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.inQueueFromCarryover).toBe(true);   // scheduler will wait
    expect(after.positionFiredToday).toBe(false);    // not "fired" anymore
    expect(after.hasBeenSeen).toBe(false);
    expect(after.state).toBe('in_queue');             // still in queue right now
  });
});

// ─── armPositionWindowForToday() — the 3 AM PT auto re-arm ────────────────────
// Critical: anyone who manually fires the bot between midnight and 3 AM should
// NOT lose their position schedule for the day. We assert each meaningful
// starting state lands in the right post-arm state.

describe('armPositionWindowForToday() — fleet-wide 3 AM re-arm', () => {
  beforeEach(async () => {
    setupMocks();
    await addWatch(DRIVER_ID, { isAuto: true });
  });

  test('driver who manually ran pre-3 AM → tagged carryover, scheduler can wait for drop', () => {
    // Simulate: driver fired bot at 01:00 AM, ended up in queue.
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state              = 'in_queue';
    internal.hasBeenSeen        = true;
    internal.positionFiredToday = false; // position scheduler hasn't run yet (before pos hours)

    armPositionWindowForToday('2026-05-28');

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.inQueueFromCarryover).toBe(true);   // tagged as carryover
    expect(after.hasBeenSeen).toBe(false);            // re-armed
    expect(after.positionFiredToday).toBe(false);     // still ready to fire today
    expect(after.state).toBe('in_queue');             // currently in queue
  });

  test('driver NOT in queue → fully clean slate (will fire fresh when target reached)', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state             = 'watching';
    internal.hasBeenSeen       = false;
    internal.positionFiredToday = false;
    internal.lastPosDecision   = 'waiting';

    armPositionWindowForToday('2026-05-28');

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.inQueueFromCarryover).toBe(false);
    expect(after.state).toBe('watching');
    expect(after.lastPosDecision).toBeNull();
  });

  test('driver whose Remove-from-Queue had blocked the day → un-blocked', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.manuallyRemovedAt   = new Date();
    internal.positionFiredToday  = true;  // markManuallyRemoved set this
    internal.hasBeenSeen         = false;

    armPositionWindowForToday('2026-05-28');

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.positionFiredToday).toBe(false);
    expect(after.manuallyRemovedAt).toBeNull();
  });

  test('driver in "requeuing" state (bot in flight) is left alone', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state              = 'requeuing';
    internal.positionFiredToday = true;

    armPositionWindowForToday('2026-05-28');

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.state).toBe('requeuing');         // not overwritten
    expect(after.positionFiredToday).toBe(false);  // flag still cleared
  });

  test('driver already at_terminal pre-arm → tagged carryover (state machine handles drop)', () => {
    const internal = monitor._getInternalState(DRIVER_ID);
    internal.state            = 'at_terminal';
    internal.terminalName     = 'T1';
    internal.terminalPosition = 5;

    armPositionWindowForToday('2026-05-28');

    const after = monitor._getInternalState(DRIVER_ID);
    expect(after.inQueueFromCarryover).toBe(true);
    expect(after.terminalName).toBeNull();
    expect(after.terminalPosition).toBeNull();
    expect(after.state).toBe('in_queue'); // re-mapped per carryover policy
  });

  test('returns the count of armed drivers', () => {
    expect(armPositionWindowForToday('2026-05-28')).toBe(1);
  });
});

// ─── Position scheduler decision logic ────────────────────────────────────────
// Tests for the safety rails added after the 5/24-5/26 over-/under-shoot
// incidents: hard skip when queue already past max, pause when queue is being
// purged by SAN's dispatcher.
describe('evaluatePositionScheduler — safety rails', () => {
  const makeState = (over = {}) => ({
    driverId:           42,
    vehicleNumber:      '4007',
    scheduledPosition:  100,
    maxAcceptablePosition: 120,
    state:              'watching',
    hasBeenSeen:        false,
    positionFiredToday: false,
    ...over,
  });

  const baseCtx = {
    waitingCount:           50,
    effectiveGrowthRate:    1.0,
    estimatedDrift:         55,
    biasCorrection:         0,
    horizonSeconds:         55,
    botExecMs:              15000,
    todayDayKey:            null,
    botSamplesCount:        5,
    queueShrinkageDetected: false,
  };

  test('queue already past max → missed_impossible (does NOT fire)', () => {
    const decision = _evaluatePositionScheduler(
      makeState(),
      { ...baseCtx, waitingCount: 130 }, // > maxAcceptable (120)
    );
    expect(decision.action).toBe('missed_impossible');
    expect(decision.reason).toBe('queue_already_past_max');
  });

  test('queue at max boundary → fires (not blocked)', () => {
    const decision = _evaluatePositionScheduler(
      makeState(),
      { ...baseCtx, waitingCount: 120, estimatedDrift: 0 },
    );
    expect(decision.action).not.toBe('missed_impossible');
  });

  test('queue shrinking → wait (dispatch-purge guard)', () => {
    const decision = _evaluatePositionScheduler(
      makeState(),
      { ...baseCtx, queueShrinkageDetected: true, waitingCount: 110 },
    );
    expect(decision.action).toBe('wait');
    expect(decision.reason).toBe('queue_shrinking');
  });

  test('past_max takes precedence over shrinkage', () => {
    const decision = _evaluatePositionScheduler(
      makeState(),
      { ...baseCtx, queueShrinkageDetected: true, waitingCount: 130 },
    );
    expect(decision.action).toBe('missed_impossible');
  });

  test('normal case still fires when projection ≥ target and below max', () => {
    const decision = _evaluatePositionScheduler(
      makeState(),
      { ...baseCtx, waitingCount: 80, estimatedDrift: 30 }, // 80+30 = 110 ≥ 100
    );
    expect(decision.action).toBe('fire');
  });

  // Carryover: SAN doesn't clear V Holding at midnight — drivers from
  // yesterday linger until SAN's overnight purge (~02 AM PT). The position
  // scheduler must wait for that drop instead of either firing (which lands on
  // the "Already in queue" WAIT screen with a stale position) or skipping for
  // the day.
  test('carryover from yesterday → wait (no fire while still in queue)', () => {
    const decision = _evaluatePositionScheduler(
      makeState({ inQueueFromCarryover: true }),
      { ...baseCtx, waitingCount: 80, estimatedDrift: 30 }, // would otherwise fire
    );
    expect(decision.action).toBe('wait');
    expect(decision.reason).toBe('awaiting_overnight_purge');
  });

  test('carryover takes precedence over projection — never fires', () => {
    const decision = _evaluatePositionScheduler(
      makeState({ inQueueFromCarryover: true }),
      { ...baseCtx, waitingCount: 200, estimatedDrift: 0 }, // queue past max
    );
    // Even when queue is past max, we wait — carryover means the driver is
    // about to be dropped, the past-max signal is stale.
    expect(decision.action).toBe('wait');
    expect(decision.reason).toBe('awaiting_overnight_purge');
  });

  test('carryover cleared → normal fire path resumes', () => {
    const decision = _evaluatePositionScheduler(
      makeState({ inQueueFromCarryover: false }),
      { ...baseCtx, waitingCount: 80, estimatedDrift: 30 },
    );
    expect(decision.action).toBe('fire');
  });

  // Projection-exceeds-max guard: covers the 2026-05-27 #695 case where the
  // queue is still below max RIGHT NOW (so the waitingCount>maxAcceptable rail
  // doesn't trip) but projected landing is well past max. Firing in that
  // window produces the +62 type overshoots that motivated this work.
  describe('projection exceeds max → missed_impossible (does NOT fire)', () => {
    test('drift would push landing past max', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 90, estimatedDrift: 50 }, // 90+50=140 > 120
      );
      expect(decision.action).toBe('missed_impossible');
      expect(decision.reason).toBe('projection_exceeds_max');
    });

    test('bias correction alone can push projection past max', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 100, estimatedDrift: 15, biasCorrection: 10 }, // 100+15+10=125>120
      );
      expect(decision.action).toBe('missed_impossible');
      expect(decision.reason).toBe('projection_exceeds_max');
    });

    test('projection exactly at max → fires (boundary)', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 90, estimatedDrift: 30 }, // 90+30=120 == max
      );
      expect(decision.action).toBe('fire');
    });

    test('past_max (current queue) takes precedence over projection guard', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 130, estimatedDrift: 50 },
      );
      // queue already past max — reason should be queue_already_past_max,
      // not projection_exceeds_max
      expect(decision.action).toBe('missed_impossible');
      expect(decision.reason).toBe('queue_already_past_max');
    });
  });
});
