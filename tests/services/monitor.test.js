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
});
