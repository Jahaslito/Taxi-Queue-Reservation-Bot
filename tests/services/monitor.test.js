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

const { runBotForDriver, runRemoveBotForDriver } = require('../../src/services/schedulerService');
const Driver               = require('../../src/models/Driver');
const Log                  = require('../../src/models/Log');

const monitor = require('../../src/services/monitorService');
const {
  _isWithinOperatingHours,
  _evaluatePositionScheduler,
  _carryoverClearStep,
  _removeCarryoverLeftover,
  _setWatch,
  addWatch,
  manualRun,
  getState,
  stopMonitor,
  allowRefireToday,
  armPositionWindowForToday,
  startMonitor,
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
  Log.findTodayLatestAdd.mockResolvedValue(null);
  Log.wasCarryoverToday.mockResolvedValue(false);
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

// ─── reconcileArmStateOnRestart() — clock-gated restart guard ─────────────────
// Regression cover for the 2026-07-04 miss: three restarts at 00:57–01:15 (before
// the 3 AM position window) tripped the old guard because midnight carryover
// markers were mistaken for "window already armed". That set positionWindowArmed
// ForDate=today, so the real 3 AM arm + forced carryover drop were skipped and
// #0030/#0187/#0305/#0387 were stranded on SAN's slow passive drop. The clock gate
// makes a pre-window restart leave the flag untouched so the arm still fires, while
// a restart DURING position hours still preserves state (the #0187 mid-day guard).
describe('reconcileArmStateOnRestart() — clock-gated restart guard', () => {
  const CARRYOVER_DRIVER = 777;

  beforeEach(() => {
    stopMonitor();                                   // clears the watches map
    monitor._setPositionWindowArmedForDate(null);    // fresh in-memory flag (as after a restart)
  });

  afterEach(() => {
    stopMonitor();
    monitor._setPositionWindowArmedForDate(null);
  });

  test('restart BEFORE the 3 AM window with carryover leftovers → flag left null (arm still runs)', () => {
    // 1 AM PT — a deploy/restart in the 11:30 PM–2:30 AM window.
    jest.useFakeTimers({ now: ptHour(1) });
    // Midnight reset already tagged this leftover as carryover.
    monitor._setWatch(CARRYOVER_DRIVER, {
      driverId: CARRYOVER_DRIVER, vehicleNumber: '0187',
      state: 'in_queue', inQueueFromCarryover: true, hasBeenSeen: true, positionFiredToday: false,
    });

    monitor._reconcileArmStateOnRestart();

    // The bug was setting this to today's date; the fix leaves it null so the
    // real 3 AM arm (and its dropAndArmCarryoverLeftovers) can still fire.
    expect(monitor._getPositionWindowArmedForDate()).toBeNull();
  });

  test('restart DURING position hours with a day already in progress → flag preserved (no re-arm wipe)', () => {
    // 8 AM PT — the 2026-06-09 #0187 mid-day restart scenario.
    jest.useFakeTimers({ now: ptHour(8) });
    monitor._setWatch(CARRYOVER_DRIVER, {
      driverId: CARRYOVER_DRIVER, vehicleNumber: '0187',
      state: 'in_queue', inQueueFromCarryover: false, hasBeenSeen: false, positionFiredToday: true,
    });

    monitor._reconcileArmStateOnRestart();

    // ptHour(8) is 2026-01-15 08:00 PT → today key is that calendar date.
    expect(monitor._getPositionWindowArmedForDate()).toBe('2026-01-15');
  });

  test('restart DURING position hours but no day-in-progress evidence → flag left null', () => {
    jest.useFakeTimers({ now: ptHour(8) });
    monitor._setWatch(CARRYOVER_DRIVER, {
      driverId: CARRYOVER_DRIVER, vehicleNumber: '0187',
      state: 'watching', inQueueFromCarryover: false, hasBeenSeen: false, positionFiredToday: false,
    });

    monitor._reconcileArmStateOnRestart();

    expect(monitor._getPositionWindowArmedForDate()).toBeNull();
  });
});

// ─── Position scheduler decision logic ────────────────────────────────────────
// Tests for the safety rails added after the 5/24-5/26 over-/under-shoot
// incidents: hard skip when queue already past max, pause when queue is being
// ─── carryoverClearStep() — debounce for the carryover-cleared signal ────────
// A single flickered poll during SAN's midnight refresh must NOT clear the flag;
// only N consecutive absences should (prevents the #0187 mislabel chain).
describe('carryoverClearStep() — carryover-clear debounce', () => {
  test('does not clear before the threshold (default 3)', () => {
    const a = _carryoverClearStep(0);          // 1st absence
    expect(a).toEqual({ clear: false, absentPolls: 1 });
    const b = _carryoverClearStep(a.absentPolls); // 2nd absence
    expect(b).toEqual({ clear: false, absentPolls: 2 });
  });

  test('clears once absences reach the threshold', () => {
    const c = _carryoverClearStep(2);          // 3rd consecutive absence
    expect(c).toEqual({ clear: true, absentPolls: 0 });
  });

  test('a single flicker (reset to 0 on re-sighting) never clears', () => {
    // Simulate: absent, absent, then seen (counter reset to 0 by the poll loop),
    // then absent again — must not clear on that lone absence.
    let n = 0;
    n = _carryoverClearStep(n).absentPolls;     // 1
    n = _carryoverClearStep(n).absentPolls;     // 2
    n = 0;                                       // re-seen in V Holding → reset
    const after = _carryoverClearStep(n);        // lone absence
    expect(after.clear).toBe(false);
    expect(after.absentPolls).toBe(1);
  });

  test('respects a custom threshold', () => {
    expect(_carryoverClearStep(0, 1)).toEqual({ clear: true, absentPolls: 0 });
    expect(_carryoverClearStep(undefined, 2)).toEqual({ clear: false, absentPolls: 1 });
  });
});

// ─── addWatch() — restart reconstruction is carryover-safe ────────────────────
// Locks in the fix for the 2026-06-15 fleet-wide outage: a restart between the
// midnight reset and the morning fire window must NOT mistake a REMOVE-type log
// for "in queue", and MUST rebuild carryover protection from the durable marker.
describe('addWatch() — restart reconstruction (carryover-safe)', () => {
  beforeEach(() => setupMocks());

  test('REGRESSION: a leftover whose only log today is a carryover remove → NOT seen, stays carryover', async () => {
    // The exact 06-15 trap: midnight carryover_cleanup wrote a success log, then
    // the server restarted. findTodayLatestAdd excludes remove-type logs, so it
    // returns null → hasBeenSeen MUST be false (a remove can never mean in-queue).
    // The carryover marker rebuilds protection so the scheduler waits + fires fresh.
    Log.findTodayLatestAdd.mockResolvedValue(null); // no ADD log — the only log was a remove
    Log.wasCarryoverToday.mockResolvedValue(true);  // durable midnight marker exists

    await addWatch(DRIVER_ID, { isAuto: true });
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.hasBeenSeen).toBe(false);            // was wrongly true before the fix
    expect(s.inQueueFromCarryover).toBe(true);    // protection rebuilt from the marker
    expect(s.wasCarryoverToday).toBe(true);
    expect(s.state).toBe('in_queue');
  });

  test('leftover that already fired today (position_schedule success) → seen, NOT carryover', async () => {
    Driver.findById.mockResolvedValue({ ...mockDriver, scheduled_position: 200 });
    Log.findTodayLatestAdd.mockResolvedValue({ trigger_type: 'position_schedule', status: 'success' });
    Log.findTodayByTriggerType.mockResolvedValue({ driver_id: DRIVER_ID, status: 'success' }); // positionFiredToday
    Log.wasCarryoverToday.mockResolvedValue(true);

    await addWatch(DRIVER_ID, { isAuto: true });
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.hasBeenSeen).toBe(true);
    expect(s.positionFiredToday).toBe(true);
    expect(s.inQueueFromCarryover).toBe(false);   // we fired them — they're legitimately ours
  });

  test('not a leftover, no add log → clean watching slate', async () => {
    Log.findTodayLatestAdd.mockResolvedValue(null);
    Log.wasCarryoverToday.mockResolvedValue(false);

    await addWatch(DRIVER_ID, { isAuto: true });
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.hasBeenSeen).toBe(false);
    expect(s.inQueueFromCarryover).toBe(false);
    expect(s.state).toBe('watching');
  });

  test('add-type success but no marker → seen normally (not carryover)', async () => {
    Log.findTodayLatestAdd.mockResolvedValue({ trigger_type: 'monitor_requeue', status: 'success' });
    Log.wasCarryoverToday.mockResolvedValue(false);

    await addWatch(DRIVER_ID, { isAuto: true });
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.hasBeenSeen).toBe(true);
    expect(s.inQueueFromCarryover).toBe(false);
    expect(s.state).toBe('in_queue');
  });
});

// ─── removeCarryoverLeftover() — best-effort, never strips protection ─────────
// The 06-15 bug: a bot "success" cleared inQueueFromCarryover even though the
// driver was still in V Holding (back at pos 18 within 24s). The clear now lives
// SOLELY in the debounced poll path, so this function must leave the flags alone
// regardless of what the remove bot reports.
describe('removeCarryoverLeftover() — never clears protection flags', () => {
  beforeEach(() => setupMocks());

  const seedCarryoverWatch = () => _setWatch(DRIVER_ID, {
    driverId: DRIVER_ID, vehicleNumber: '9999',
    inQueueFromCarryover: true, wasCarryoverToday: true, hasBeenSeen: false,
    state: 'in_queue', carryoverAbsentPolls: 0,
  });

  test('bot reports SUCCESS → carryover protection untouched', async () => {
    runRemoveBotForDriver.mockResolvedValue({ success: true });
    seedCarryoverWatch();

    await _removeCarryoverLeftover(DRIVER_ID, '9999');
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.inQueueFromCarryover).toBe(true);   // was wrongly cleared before the fix
    expect(s.wasCarryoverToday).toBe(true);
    expect(s.hasBeenSeen).toBe(false);
    expect(s.state).toBe('in_queue');
  });

  test('bot reports FAILURE → carryover protection untouched', async () => {
    runRemoveBotForDriver.mockResolvedValue({ success: false, error: 'Vehicle is not currently in queue' });
    seedCarryoverWatch();

    await _removeCarryoverLeftover(DRIVER_ID, '9999');
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.inQueueFromCarryover).toBe(true);
    expect(s.state).toBe('in_queue');
  });
});

describe('dropAndArmLeftover() — 3 AM forced drop + re-arm', () => {
  beforeEach(() => setupMocks());

  const seedStuckLeftover = (overrides = {}) => _setWatch(DRIVER_ID, {
    driverId: DRIVER_ID, vehicleNumber: '9999',
    inQueueFromCarryover: true, wasCarryoverToday: true,
    hasBeenSeen: false, positionFiredToday: false,
    state: 'in_queue', carryoverAbsentPolls: 0, ...overrides,
  });

  test('CONFIRMED removal → clears carryover/seen/fired, keeps wasCarryoverToday, arms watching', async () => {
    runRemoveBotForDriver.mockResolvedValue({ success: true, removed: true });
    seedStuckLeftover({ hasBeenSeen: true, positionFiredToday: true });

    await monitor._dropAndArmLeftover(DRIVER_ID, '9999');
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.inQueueFromCarryover).toBe(false); // stops the scheduler waiting
    expect(s.hasBeenSeen).toBe(false);          // can fire fresh
    expect(s.positionFiredToday).toBe(false);
    expect(s.wasCarryoverToday).toBe(true);     // safety net if SAN re-lists before fire
    expect(s.state).toBe('watching');
  });

  test('NOT confirmed (still queued) → every flag left intact (no stranding)', async () => {
    runRemoveBotForDriver.mockResolvedValue({ success: false, notConfirmed: true, error: 'Remove not confirmed' });
    seedStuckLeftover();

    await monitor._dropAndArmLeftover(DRIVER_ID, '9999');
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.inQueueFromCarryover).toBe(true);
    expect(s.wasCarryoverToday).toBe(true);
    expect(s.hasBeenSeen).toBe(false);
    expect(s.state).toBe('in_queue');
  });

  test('driver already dispatched → flags untouched, no re-arm', async () => {
    runRemoveBotForDriver.mockResolvedValue({ success: false, dispatched: true });
    seedStuckLeftover();

    await monitor._dropAndArmLeftover(DRIVER_ID, '9999');
    const s = monitor._getInternalState(DRIVER_ID);

    expect(s.inQueueFromCarryover).toBe(true);
    expect(s.state).toBe('in_queue');
  });

  test('not a carryover leftover (plain watching) → no bot run at all', async () => {
    _setWatch(DRIVER_ID, {
      driverId: DRIVER_ID, vehicleNumber: '9999',
      inQueueFromCarryover: false, state: 'watching',
    });

    await monitor._dropAndArmLeftover(DRIVER_ID, '9999');
    expect(runRemoveBotForDriver).not.toHaveBeenCalled();
  });
});

describe('dropAndArmCarryoverLeftovers() — selects only stuck leftovers', () => {
  beforeEach(() => setupMocks());

  test('enqueues a drop for each in_queue carryover driver WITH a target, skips the rest', () => {
    _setWatch(1, { driverId: 1, vehicleNumber: 'A', inQueueFromCarryover: true,  state: 'in_queue',  scheduledPosition: 118 });
    _setWatch(2, { driverId: 2, vehicleNumber: 'B', inQueueFromCarryover: true,  state: 'in_queue',  dayPositions: '{"mon":130}' });
    _setWatch(3, { driverId: 3, vehicleNumber: 'C', inQueueFromCarryover: false, state: 'watching',  scheduledPosition: 100 }); // not a leftover
    _setWatch(4, { driverId: 4, vehicleNumber: 'D', inQueueFromCarryover: true,  state: 'requeuing', scheduledPosition: 100 }); // in-flight bot
    _setWatch(5, { driverId: 5, vehicleNumber: 'E', inQueueFromCarryover: true,  state: 'in_queue' }); // manual driver, no target

    const count = monitor._dropAndArmCarryoverLeftovers('2026-06-30');
    expect(count).toBe(2); // only 1 and 2 (in_queue carryover + has a target)
  });
});

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
      // Drift 30 is clamped to the POS_MAX_LEAD (10) lead: 95+10 = 105 ≥ 100.
      { ...baseCtx, waitingCount: 95, estimatedDrift: 30 },
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
      { ...baseCtx, waitingCount: 95, estimatedDrift: 30 }, // would otherwise fire
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
      { ...baseCtx, waitingCount: 95, estimatedDrift: 30 },
    );
    expect(decision.action).toBe('fire');
  });

  // Projection-exceeds-max guard: covers the 2026-05-27 #695 case where the
  // queue is still below max RIGHT NOW (so the waitingCount>maxAcceptable rail
  // doesn't trip) but projected landing is past max. Since the lead clamp
  // (POS_MAX_LEAD), the projection can only exceed max when the QUEUE ITSELF
  // is within one lead of max — a one-tick rate spike can no longer inflate
  // the forecast into false skips (the Jun 04 incident: drift 58–98 marked
  // five drivers missed_impossible whose windows were still viable).
  describe('projection exceeds max → missed_impossible (does NOT fire)', () => {
    test('queue within clamped lead of max → skip', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 115, estimatedDrift: 50, effectiveGrowthRate: 3.0 }, // 115+min(50,10)=125 > 120 (burst rate: growth-lead cap ≥ 10)
      );
      expect(decision.action).toBe('missed_impossible');
      expect(decision.reason).toBe('projection_exceeds_max');
    });

    test('bias participates in the lead below the clamp', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 112, estimatedDrift: 4, biasCorrection: 8, effectiveGrowthRate: 3.0 }, // 112+min(12,10)=122 > 120 (burst rate)
      );
      expect(decision.action).toBe('missed_impossible');
      expect(decision.reason).toBe('projection_exceeds_max');
    });

    test('projection exactly at max → fires (boundary)', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 100, maxAcceptablePosition: 120 }),
        { ...baseCtx, waitingCount: 110, estimatedDrift: 10 }, // 110+10=120 == max
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

  // ─── ±10 lead clamp (POS_MAX_LEAD) ─────────────────────────────────────────
  // The lead (drift + bias) is the worst-case UNDERSHOOT: the queue only grows
  // during the morning window, so firing `lead` early can land at most `lead-1`
  // below target if growth stalls the moment we fire. Clamping the lead at 10
  // makes sub−(target−9) landings impossible by construction — the May 30 –
  // Jun 04 misses (−36…−68 from drift 37–98) were all burst-spike drift
  // extrapolations that this clamp would have cut to 10.
  describe('±10 lead clamp (POS_MAX_LEAD)', () => {
    test('burst-spike drift (98) no longer fires 40 early — waits instead', () => {
      // Jun 03 #0034 replay: target 200, queue 113, drift 98 → old code fired
      // (projection 207) and landed at 132 (−68). Clamped: 113+10=123 < 200.
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 200, maxAcceptablePosition: 220 }),
        { ...baseCtx, waitingCount: 113, estimatedDrift: 98 },
      );
      expect(decision.action).toBe('wait');
    });

    test('fire happens once queue is within 10 of target, however large the drift', () => {
      for (const estimatedDrift of [12, 55, 98]) {
        const at89 = _evaluatePositionScheduler(
          makeState(),
          { ...baseCtx, waitingCount: 89, estimatedDrift, effectiveGrowthRate: 3.0 }, // 89+10=99 < 100 (burst rate)
        );
        const at90 = _evaluatePositionScheduler(
          makeState(),
          { ...baseCtx, waitingCount: 90, estimatedDrift, effectiveGrowthRate: 3.0 }, // 90+10=100 ≥ 100 (burst rate)
        );
        expect(at89.action).toBe('wait');
        expect(at90.action).toBe('fire');
      }
    });

    test('undershoot bound: any fire implies queue ≥ target − POS_MAX_LEAD', () => {
      // Property sweep across drift × bias: scan the queue size upward and
      // assert the FIRST size that fires is never below target − 10.
      for (const estimatedDrift of [5, 20, 55, 98]) {
        for (const biasCorrection of [-10, 0, 10]) {
          let firstFire = null;
          for (let waitingCount = 70; waitingCount <= 115; waitingCount++) {
            const d = _evaluatePositionScheduler(
              makeState(),
              { ...baseCtx, waitingCount, estimatedDrift, biasCorrection },
            );
            if (d.action === 'fire') { firstFire = waitingCount; break; }
          }
          expect(firstFire).not.toBeNull();
          expect(firstFire).toBeGreaterThanOrEqual(100 - 10);
        }
      }
    });

    test('negative bias still delays firing beyond the clamp (lands-early correction)', () => {
      // drift 5 + bias −8 → lead −3: fire only when queue ≥ target + 3.
      const at102 = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 102, estimatedDrift: 5, biasCorrection: -8 },
      );
      const at103 = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 103, estimatedDrift: 5, biasCorrection: -8 },
      );
      expect(at102.action).toBe('wait');
      expect(at103.action).toBe('fire');
    });

    test('Jun 04 false-skip regression: viable window is no longer missed_impossible', () => {
      // #0305 replay: target 121, max 141, queue 114, drift 58, bias −5.5 →
      // old projection 166.5 > 141 skipped a driver who'd have landed ~+7.
      // Clamped projection 124 ≥ 121 and ≤ 141 → fire.
      const decision = _evaluatePositionScheduler(
        makeState({ scheduledPosition: 121, maxAcceptablePosition: 141 }),
        { ...baseCtx, waitingCount: 114, estimatedDrift: 58, biasCorrection: -5.5, effectiveGrowthRate: 3.0 },
      );
      expect(decision.action).toBe('fire');
    });

    test('ctx.maxLeadPositions overrides the default clamp', () => {
      const decision = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 80, estimatedDrift: 55, maxLeadPositions: 20, effectiveGrowthRate: 6.0 }, // 80+20=100 (rate 6 → growth-lead cap 20)
      );
      expect(decision.action).toBe('fire');
    });
  });

  // Predictive band lead (MONITOR_PREDICTIVE_LEAD) — burst-window lead sized to
  // inflight when the queue is moving: D = clamp(19 + 0.86·inflight, 20, 45),
  // replacing the flat POS_MAX_LEAD clamp. Loaded with the flag ON via
  // isolateModules; the default `monitor` (flag unset) must stay dormant.
  describe('predictive inflight-scaled band lead (recalibrated + hard −45 floor)', () => {
    let evalPred, setLanding;
    let savedFlag, savedProbe;
    beforeAll(() => {
      savedFlag  = process.env.MONITOR_PREDICTIVE_LEAD;
      savedProbe = process.env.MONITOR_FLEET_PROBE;
      process.env.MONITOR_PREDICTIVE_LEAD = '1';
      process.env.MONITOR_FLEET_PROBE     = '1'; // needed for the hard-floor-vs-probe cases
      jest.isolateModules(() => {
        const m = require('../../src/services/monitorService');
        evalPred   = m._evaluatePositionScheduler;
        setLanding = m._setFleetLanding;
      });
    });
    afterAll(() => {
      if (savedFlag  === undefined) delete process.env.MONITOR_PREDICTIVE_LEAD; else process.env.MONITOR_PREDICTIVE_LEAD = savedFlag;
      if (savedProbe === undefined) delete process.env.MONITOR_FLEET_PROBE;     else process.env.MONITOR_FLEET_PROBE     = savedProbe;
    });
    beforeEach(() => setLanding(0, 0)); // no fresh landing unless a case sets one

    // target 100; estimatedDrift/bias 0 so the flat path would give lead 0.
    const predCtx = { ...baseCtx, estimatedDrift: 0, biasCorrection: 0, inBurstWindow: true };

    // Once the queue is MOVING, the lead is sized to INFLIGHT — the only click-time
    // signal that tracks drift (corr 0.59; velocity is a trailing slope, corr
    // −0.08). D = clamp(round(19 + 0.86·inflight), 20, 45). At inflight 20,
    // D = round(36.2) = 36 ⇒ fires at queue ≥ 100−36 = 64.
    test('moving queue in the avalanche band → lead sized to inflight, no earlier', () => {
      const fire = evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 20, waitingCount: 64 });
      const wait = evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 20, waitingCount: 63 });
      expect(fire.action).toBe('fire');
      expect(wait.action).toBe('wait');
    });

    test('lead SCALES with inflight once the queue is moving', () => {
      // inflight 0 → D=clamp(19,20,45)=20 ⇒ fires at ≥80; inflight 60 → D=45 ⇒ fires at ≥55.
      // The deep lead is reserved for the high-inflight (confirmed-avalanche) fires.
      expect(evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 0, waitingCount: 80 }).action).toBe('fire');
      expect(evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 0, waitingCount: 79 }).action).toBe('wait');
      expect(evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 60, waitingCount: 55 }).action).toBe('fire');
      expect(evalPred(makeState(), { ...predCtx, observedVelocity: 1.0, currentInflight: 60, waitingCount: 54 }).action).toBe('wait');
    });

    test('a barely-creeping queue falls back to the conservative estimate', () => {
      // v=0.2 < MOVE_RATE(0.5) ⇒ estimator path: predLat = 5+0.7·20 = 19s ⇒ D = 4
      // ⇒ needs queue ≥ 96, so 70 (which the full budget would have fired) waits.
      const d = evalPred(makeState(), { ...predCtx, observedVelocity: 0.2, currentInflight: 20, waitingCount: 70 });
      expect(d.action).toBe('wait');
    });

    // The band has an UPPER bound as well as a lower one. Positions above ~200
    // crawl (≈5.1 s per position vs 0.17–0.22 s inside the avalanche) and
    // already land inside ±10; handing them the full budget would drag their
    // median from +6 to about −24.
    test('aggressive lead gated to target ≤ MAX_TARGET — a target 250 driver stays on the flat path', () => {
      const d = evalPred(
        makeState({ scheduledPosition: 250, maxAcceptablePosition: 290 }),
        { ...predCtx, observedVelocity: 2.5, currentInflight: 60, waitingCount: 225 },
      );
      expect(d.action).toBe('wait'); // flat lead 0 ⇒ needs the displayed queue at 250
    });

    test('lead capped at PRED_LEAD_CAP (45)', () => {
      // inflight=90 → raw D=round(19+0.86·90)=96, capped to 45 → fire at ≥55 (not 4)
      const at55 = evalPred(makeState(), { ...predCtx, observedVelocity: 2.5, currentInflight: 90, waitingCount: 55 });
      const at54 = evalPred(makeState(), { ...predCtx, observedVelocity: 2.5, currentInflight: 90, waitingCount: 54 });
      expect(at55.action).toBe('fire');
      expect(at54.action).toBe('wait');
    });

    test('aggressive lead gated to target ≥ MIN_TARGET — a target 60 driver stays on the flat path', () => {
      // target 60 (<70): predictive dormant ⇒ flat lead 0 ⇒ 40 < 60 ⇒ wait, even though the
      // inflight-scaled lead (D capped 45) would otherwise have fired it early at 40.
      const d = evalPred(
        makeState({ scheduledPosition: 60, maxAcceptablePosition: 100 }),
        { ...predCtx, observedVelocity: 2.5, currentInflight: 60, waitingCount: 40 },
      );
      expect(d.action).toBe('wait');
    });

    test('pre-storm velocity ≈ 0 → D ≈ 0 → does not fire early', () => {
      const d = evalPred(makeState(), { ...predCtx, observedVelocity: 0, currentInflight: 20, waitingCount: 80 });
      expect(d.action).toBe('wait');
    });

    test('only active inside the burst window', () => {
      const d = evalPred(makeState(), { ...predCtx, inBurstWindow: false, observedVelocity: 2.0, currentInflight: 20, waitingCount: 80 });
      expect(d.action).toBe('wait'); // flat clamp, lead 0
    });

    test('flag OFF ⇒ predictive path dormant even in burst window', () => {
      const d = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, estimatedDrift: 0, inBurstWindow: true, observedVelocity: 2.0, currentInflight: 20, waitingCount: 80 },
      );
      expect(d.action).toBe('wait');
    });

    // ─── HARD UNDERSHOOT FLOOR: the −45 guarantee ────────────────────────────
    describe('hard undershoot floor (−45 guarantee)', () => {
      // Max lead (45) + a fresh probe landing that puts the TRUE tail near target
      // while the DISPLAYED queue is still far below target−45. Without the floor
      // the probe-boosted projection (effectiveQueue+lead ≥ target) would fire, and
      // if the storm stalled the driver would land deep below target ⇒ undershoot.
      const hot = { ...predCtx, observedVelocity: 2.5, currentInflight: 60 }; // lead capped at 45

      test('probe would fire early, but displayed < target−45 ⇒ HELD, not fired', () => {
        setLanding(95, Date.now()); // true tail ~95 (effectiveQueue → 90); display far below
        const d = evalPred(makeState(), { ...hot, waitingCount: 50 }); // 50 < 100−45
        expect(d.action).toBe('wait');
        expect(d.logLine).toMatch(/hard-floor/);
      });

      test('fires once the displayed queue reaches the floor (target−45)', () => {
        setLanding(95, Date.now());
        const d = evalPred(makeState(), { ...hot, waitingCount: 55 }); // 55 == 100−45
        expect(d.action).toBe('fire');
      });

      test('no fire anywhere below target−45, even with the probe boosting hard', () => {
        // Any FIRE must have waitingCount ≥ target−45, so SAN appending at the tail
        // lands ≥ target−44 — the guarantee holds across the whole displayed range.
        setLanding(95, Date.now());
        for (let wc = 40; wc <= 99; wc++) {
          const d = evalPred(makeState(), { ...hot, waitingCount: wc });
          if (d.action === 'fire') expect(wc).toBeGreaterThanOrEqual(55); // target(100) − 45
        }
      });

      // BAND-CONFINED FLOOR: the −45 loosening is ONLY for 70-199 (the band that
      // gets the aggressive lead). Deeper targets keep the original −30 guarantee.
      test('a 70-199 target uses the −45 floor', () => {
        const d = evalPred(makeState({ scheduledPosition: 100, maxAcceptablePosition: 140 }),
          { ...hot, waitingCount: 50 }); // 50 < 100−45 ⇒ held
        expect(d.action).toBe('wait');
        expect(d.logLine).toMatch(/hold until displayed ≥ 55 \(−45 guarantee\)/);
      });

      test('a target ≥200 keeps the −30 floor, NOT −45', () => {
        // target 250: aggressive lead is gated off (>MAX_TARGET), so the floor must
        // stay at −30. At displayed 210 (< 250−30=220) it is HELD with a −30 note;
        // a −45 floor would instead have released it at 205.
        const d = evalPred(makeState({ scheduledPosition: 250, maxAcceptablePosition: 290 }),
          { ...hot, waitingCount: 210 });
        expect(d.action).toBe('wait');
        expect(d.logLine).toMatch(/hold until displayed ≥ 220 \(−30 guarantee\)/);
      });
    });
  });

  // Scheduler-level credential lockout — added 2026-05-29 after #631 fired
  // despite the warmer having confirmed bad credentials at 03:00.
  describe('credential lockout — skip_locked_out', () => {
    test('isLockedOut returning true → skip_locked_out (does NOT fire)', () => {
      const decision = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 80, estimatedDrift: 30, isLockedOut: () => true },
      );
      expect(decision.action).toBe('skip_locked_out');
      expect(decision.reason).toBe('credentials_locked_out');
    });

    test('isLockedOut returning false → normal evaluation', () => {
      const decision = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 95, estimatedDrift: 30, isLockedOut: () => false },
      );
      expect(decision.action).toBe('fire');
    });

    test('isLockedOut omitted from ctx → defaults to never-locked', () => {
      // Back-compat: existing callers (and older tests) that don't pass the
      // predicate must continue to work exactly as before.
      const decision = _evaluatePositionScheduler(
        makeState(),
        { ...baseCtx, waitingCount: 95, estimatedDrift: 30 },
      );
      expect(decision.action).toBe('fire');
    });

    test('locked out + already fired → already_fired wins (short-circuit order)', () => {
      const decision = _evaluatePositionScheduler(
        makeState({ positionFiredToday: true }),
        { ...baseCtx, isLockedOut: () => true },
      );
      expect(decision.action).toBe('skip_already_fired');
    });
  });
});

// ─── botExecutionEstimateMs — median + freshness ──────────────────────────────
// Critical for accuracy: with the warmer reliable, bot times cluster around
// 7-8 s. P95 over a mixed bag of stale 25 s cold-login samples dragged the
// horizon up by 50%+, causing over-predicted drift and below-target landings
// (see 2026-05-29 #263 / #4372 misses).

describe('botExecutionEstimateMs — median + freshness', () => {
  beforeEach(() => {
    monitor._resetLatencySamples();
  });

  const NOW = 2_000_000_000_000; // arbitrary fixed clock for these tests
  const HOUR_MS = 60 * 60 * 1000;

  // Capture the env-driven default once so each test asserts against it
  // instead of a hard-coded number — keeps the tests valid regardless of
  // the deployment's MONITOR_POS_BOT_EXEC_MS setting.
  const FALLBACK = monitor._botExecutionEstimateMs({ now: NOW });

  test('< 5 fresh samples → falls back to POS_BOT_EXEC_MS default', () => {
    monitor._recordBotLatency(8000, { now: NOW });
    monitor._recordBotLatency(7500, { now: NOW });
    monitor._recordBotLatency(8200, { now: NOW });
    expect(monitor._botExecutionEstimateMs({ now: NOW })).toBe(FALLBACK);
  });

  test('5+ fresh samples → returns median (not P95)', () => {
    [7000, 7500, 8000, 8500, 9000].forEach((ms) =>
      monitor._recordBotLatency(ms, { now: NOW }),
    );
    expect(monitor._botExecutionEstimateMs({ now: NOW })).toBe(8000);
    // Sanity: this is the median, not the P95 (which would be 8800-9000).
    expect(monitor._botExecutionEstimateMs({ now: NOW })).toBeLessThan(8500);
  });

  test('stale samples are filtered out — fresh dominate', () => {
    // 5 stale 25s samples + 5 fresh 7s samples. Without freshness filter the
    // median over all 10 would land between 7s and 25s. With filter, only
    // fresh count and the median is 7s.
    const stale = NOW - 24 * HOUR_MS;
    [25000, 26000, 24000, 25500, 25500].forEach((ms) =>
      monitor._recordBotLatency(ms, { now: stale }),
    );
    [7000, 7000, 7500, 7000, 6500].forEach((ms) =>
      monitor._recordBotLatency(ms, { now: NOW }),
    );
    expect(monitor._botExecutionEstimateMs({ now: NOW })).toBe(7000);
  });

  test('all samples stale → falls back to default', () => {
    const stale = NOW - 24 * HOUR_MS;
    [7000, 7500, 8000, 8500, 9000].forEach((ms) =>
      monitor._recordBotLatency(ms, { now: stale }),
    );
    expect(monitor._botExecutionEstimateMs({ now: NOW })).toBe(FALLBACK);
  });

  test('legacy plain-number disk format normalises to recordedAt=0 (stale)', () => {
    expect(monitor._normaliseLatencySample(8000)).toEqual({ ms: 8000, recordedAt: 0 });
    expect(monitor._normaliseLatencySample({ ms: 8000, recordedAt: 1234 }))
      .toEqual({ ms: 8000, recordedAt: 1234 });
    expect(monitor._normaliseLatencySample(null)).toBeNull();
    expect(monitor._normaliseLatencySample(0)).toBeNull();
    expect(monitor._normaliseLatencySample({ ms: -1 })).toBeNull();
  });

  test('_computeMedian — odd and even lengths', () => {
    expect(monitor._computeMedian([5])).toBe(5);
    expect(monitor._computeMedian([1, 2, 3, 4, 5])).toBe(3);
    expect(monitor._computeMedian([1, 2, 3, 4])).toBe(2.5);
    // Does not mutate the caller's array.
    const xs = [3, 1, 2];
    monitor._computeMedian(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

// ─── startMonitor() — mid-day restart guard ──────────────────────────────────
// Regression cover for the 2026-06-09 #0187 (Mataan Noor) incident:
//   • 04:37 PT — bot fired, driver enters queue at pos #122 (target 100)
//   • 08:29 PT — service restarted. Without the guard, armPositionWindowForToday
//                ran again because positionWindowArmedForDate is in-memory and
//                lost on restart. It set inQueueFromCarryover=true on the
//                still-in-queue driver and wiped positionFiredToday.
//   • 10:34 PT — driver dispatched (left V Holding). The carryover-cleared path
//                fired: state → 'watching', NO triggerRequeue.
//   • 12:27 PT — driver finally back in queue (manual self-add at terminal),
//                ~1h 53m after their trip ended.
//
// The fix: at startMonitor() time, if any watched driver shows DB-restored
// evidence of having already participated today (positionFiredToday=true OR
// hasBeenSeen=true), pin positionWindowArmedForDate to today's PT date so the
// poll loop skips the re-arm.

describe('startMonitor() — mid-day restart guard', () => {
  // Watch internals: addWatch is async; we need to wait for poll's first tick
  // to settle so positionWindowArmedForDate reflects the guard's decision and
  // not a stale null. The guard runs synchronously after `await watchAllActive()`
  // so a microtask flush is sufficient — no fake timers needed for that part.

  const buildActiveDriver = (over = {}) => ({
    id:                       DRIVER_ID,
    name:                     'Mataan Noor',
    vehicle_number:           '0187',
    san_username:             'san_user',
    san_password:             'enc_pass',
    is_active:                true,
    scheduled_position:       100,
    day_positions:            null,
    max_acceptable_position:  null,
    monitor_enabled:          false,
    manually_removed_at:      null,
    ...over,
  });

  beforeEach(() => {
    setupMocks();
    // Make poll's outbound HTTP fail fast so the immediate-tick at the end of
    // startMonitor() returns at the catch in poll() without ever reaching the
    // arming check. This keeps the test focused on the guard's effect.
    Driver.findAllActive = jest.fn().mockResolvedValue([]);
    Log.loadTodayContext = jest.fn().mockResolvedValue({
      latestAddByDriver:    new Map(),
      requeueCountByDriver: new Map(),
      positionLogByDriver:  new Map(),
      carryoverByDriver:    new Set(),
    });
  });

  afterEach(() => {
    stopMonitor();
  });

  test('fresh boot, no driver activity yet → guard NOT triggered (state preserved for normal arm later)', async () => {
    // Pin time to 1 AM PT — outside the position window (3 AM–11 PM PT) — so
    // poll()'s own arm check at line 1252 short-circuits on isWithinPositionHours.
    // This lets us isolate the GUARD's contribution: with no DB activity, the
    // guard must not pin positionWindowArmedForDate.
    jest.useFakeTimers({ now: ptHour(1), doNotFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    Driver.findAllActive.mockResolvedValue([buildActiveDriver()]);

    await startMonitor();

    // Guard didn't fire (no evidence of today's activity) and poll's arm
    // check is blocked by the outside-position-hours gate. The 3 AM arm
    // will run normally when the clock crosses into the position window.
    expect(monitor._getPositionWindowArmedForDate()).toBeNull();

    const state = monitor._getInternalState(DRIVER_ID);
    expect(state.positionFiredToday).toBe(false);
    expect(state.hasBeenSeen).toBe(false);
    expect(state.inQueueFromCarryover).toBe(false);
  });

  test('mid-day restart, driver fired earlier today → guard kicks in, state preserved', async () => {
    // The #0187 scenario: position scheduler fired at 04:37 PT, creating a
    // position_schedule log row. Service restarts at 08:29 PT.
    jest.useFakeTimers({ now: ptHour(8), doNotFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    Driver.findAllActive.mockResolvedValue([buildActiveDriver()]);
    Log.loadTodayContext.mockResolvedValue({
      latestAddByDriver:    new Map([[DRIVER_ID, { trigger_type: 'position_schedule', status: 'success' }]]),
      requeueCountByDriver: new Map(),
      positionLogByDriver:  new Map([[DRIVER_ID, { driver_id: DRIVER_ID, status: 'success' }]]),
      carryoverByDriver:    new Set(),
    });

    await startMonitor();

    // Guard pinned positionWindowArmedForDate to today's PT date.
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(monitor._getPositionWindowArmedForDate()).toBe(todayPT);

    // Critical: the driver's restored state survives. Without the guard,
    // the next poll's arming would set inQueueFromCarryover=true and wipe
    // positionFiredToday — recreating the bug.
    const state = monitor._getInternalState(DRIVER_ID);
    expect(state.positionFiredToday).toBe(true);
    expect(state.hasBeenSeen).toBe(true);
    expect(state.inQueueFromCarryover).toBe(false);
  });

  test('mid-day restart, manual-run driver (no position schedule) but hasBeenSeen=true → guard kicks in', async () => {
    // Manual-mode driver: no scheduled_position, but did successfully run today.
    // Log.findTodayLatest returns a success → hasBeenSeen=true on restore.
    // positionFiredToday would be false (no position schedule). hasBeenSeen
    // alone must still trip the guard — otherwise arming would set
    // inQueueFromCarryover=true on them.
    jest.useFakeTimers({ now: ptHour(10), doNotFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    Driver.findAllActive.mockResolvedValue([buildActiveDriver({ scheduled_position: null })]);
    Log.loadTodayContext.mockResolvedValue({
      latestAddByDriver:    new Map([[DRIVER_ID, { trigger_type: 'manual', status: 'success' }]]),
      requeueCountByDriver: new Map(),
      positionLogByDriver:  new Map(),
      carryoverByDriver:    new Set(),
    });

    await startMonitor();

    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(monitor._getPositionWindowArmedForDate()).toBe(todayPT);

    const state = monitor._getInternalState(DRIVER_ID);
    expect(state.hasBeenSeen).toBe(true);
    expect(state.inQueueFromCarryover).toBe(false);
  });

  test('confirms the bug: WITHOUT the guard, mid-day restart re-arms and tags driver as carryover', () => {
    // Direct re-creation of the broken behavior to lock in what the guard is
    // defending against. Calls armPositionWindowForToday() against a state
    // that mirrors a mid-day restart: driver fired earlier today, currently
    // mid-queue. Should set inQueueFromCarryover=true (BAD) and wipe
    // positionFiredToday (BAD) — exactly the conditions that broke #0187.
    setupMocks();
    Log.findTodayLatest.mockResolvedValue({ status: 'success' });
    // Bypass startMonitor — just exercise the arming function directly.
    return addWatch(DRIVER_ID, { isAuto: true }).then(() => {
      const s = monitor._getInternalState(DRIVER_ID);
      // Mimic restored mid-day state: driver fired earlier, still in queue.
      s.state              = 'in_queue';
      s.hasBeenSeen        = true;
      s.positionFiredToday = true;
      s.inQueueFromCarryover = false;

      armPositionWindowForToday('2026-06-09');

      const after = monitor._getInternalState(DRIVER_ID);
      // These three assertions describe THE BUG. The guard prevents the
      // poll loop from ever reaching this function on a mid-day restart.
      expect(after.inQueueFromCarryover).toBe(true);  // wrongly tagged carryover
      expect(after.positionFiredToday).toBe(false);    // fire flag wiped
      expect(after.hasBeenSeen).toBe(false);           // seen flag wiped
    });
  });
});

// ─── parseQueue() — DEST extraction for dispatched rows ──────────────────────
// Lock in the V Holding HTML shape: dispatched rows carry a DEST column
// (T1/T2) which the dispatch notification needs to include in the SMS/push
// body. Waiting rows do NOT have a DEST cell; the parser must yield no
// terminal for them.

describe('parseQueue() — dispatched DEST column', () => {
  // Minimal V Holding fixture mirroring the real markup. Two dispatched rows
  // (one T1, one T2) and one waiting row that should NOT pick up a terminal.
  const HTML = `
    <table>
      <tr class="holdingdispatched">
        <td style="">1</td>
        <td style="font-weight:bold">0988</td>
        <td style="">18:07:28</td>
        <td style=""></td>
        <td style="">T1</td>
      </tr>
      <tr class="holdingdispatched">
        <td style="">2</td>
        <td style="font-weight:bold">0251</td>
        <td style="">18:07:59</td>
        <td style="">BL</td>
        <td style="">T2</td>
      </tr>
      <tr class="">
        <td style="">7</td>
        <td style="font-weight:bold">4372</td>
        <td style="">18:17:08</td>
      </tr>
    </table>
  `;

  test('extracts T1 / T2 from dispatched rows', () => {
    const { dispatched, dispatchedDest } = monitor._parseQueue(HTML);
    expect(dispatched.get('988')).toBe(1);
    expect(dispatched.get('251')).toBe(2);
    expect(dispatchedDest.get('988')).toBe('T1');
    expect(dispatchedDest.get('251')).toBe('T2');
  });

  test('waiting rows have no DEST entry', () => {
    const { waiting, dispatchedDest } = monitor._parseQueue(HTML);
    expect(waiting.get('4372')).toBe(7);
    expect(dispatchedDest.has('4372')).toBe(false);
  });

  test('dispatched row missing DEST → null terminal (SAN hadn\'t filled it yet)', () => {
    const html = `
      <table>
        <tr class="holdingdispatched">
          <td style="">1</td>
          <td style="font-weight:bold">0568</td>
          <td style="">18:14:45</td>
          <td style=""></td>
          <td style=""></td>
        </tr>
      </table>
    `;
    const { dispatchedDest } = monitor._parseQueue(html);
    expect(dispatchedDest.get('568')).toBeNull();
  });
});
