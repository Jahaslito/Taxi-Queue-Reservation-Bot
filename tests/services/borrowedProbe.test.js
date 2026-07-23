/**
 * Borrowed tail probe (MONITOR_BORROW_PROBE) — lifecycle & safety rails.
 *
 * When no dedicated account exists, the monitor lends the probe the highest-
 * target watched drivers. These tests pin the parts that protect a paying
 * driver's account:
 *   1. a roster driver runs add→sample→confirm-remove cycles like any probe;
 *   2. RETIRE (driver dropped from the roster) force-removes if anything is
 *      left, so their real placement starts from a driver guaranteed OUT of
 *      the queue;
 *   3. a fresh day clears the borrowed set.
 *
 * Env is read at module load; Jest isolates the registry per file.
 */

process.env.MONITOR_TAIL_PROBE        = '1';   // service master gate
process.env.TAIL_PROBE_MAX_CYCLES     = '2';
process.env.TAIL_PROBE_CYCLE_PAUSE_MS = '1';
process.env.TAIL_PROBE_STAGGER_MS     = '1';

const probe = require('../../src/services/tailProbeService');

// PER-DRIVER rate-aware retire (2026-07-22) — replaces the old global calm gate.
// A driver is kept as a probe ONLY while the queue is more than a RATE-SCALED
// buffer below their target, so there is always runway to remove + re-arm before
// their fire. This is what makes storm-window borrowing safe (the 07-04 strand
// impossible by construction). borrowAllowedInCalm is now only an emergency
// global kill (widened to 400 / 60).
describe('rate-aware retire buffer (borrowRetireBuffer / borrowSafeToHold)', () => {
  const { _borrowRetireBuffer, _borrowSafeToHold } = require('../../src/services/monitorService');

  test('floor is the user +20 at calm rates', () => {
    expect(_borrowRetireBuffer(0)).toBe(20);
    expect(_borrowRetireBuffer(0.5)).toBe(20);   // 0.5×30=15 < 20 floor
  });
  test('scales with the storm — 40/s needs ~1200 positions of runway', () => {
    expect(_borrowRetireBuffer(2)).toBe(60);     // 2×30
    expect(_borrowRetireBuffer(40)).toBe(1200);  // 40×30 — a fixed +20 would be 0.5s, unsafe
  });
  test('safe to hold only while target is beyond the rate-aware buffer', () => {
    // calm: target 300, queue 40 → 260 > 20 → safe
    expect(_borrowSafeToHold(300, 40, 0.5)).toBe(true);
    // 40/s storm: even target 300 at queue 100 has only 200 runway < 1200 → NOT safe → retire
    expect(_borrowSafeToHold(300, 100, 40)).toBe(false);
    // winddown (5/s): target 300, queue 130 → 170 > 150 buffer → still safe
    expect(_borrowSafeToHold(300, 130, 5)).toBe(true);
    // driver within +20 of target at calm → retire (the user's rule)
    expect(_borrowSafeToHold(300, 285, 0.5)).toBe(false);
  });
});

// Damage minimization: only ever two fixed accounts — 4000 + the pinned
// highest-target driver, never rotating as drivers retire.
describe('two-account selection (selectBorrowAccounts)', () => {
  const { _selectBorrowAccounts } = require('../../src/services/monitorService');
  const C = (driverId, target, preferred = false) => ({ driverId, vehicle: String(driverId), target, preferred });

  test('picks the preferred (4000) + the single highest-target driver', () => {
    const elig = [C(1, 100), C(2, 320), C(9, 275), C(40, 150, true)];
    const { chosen, pinnedSecondId } = _selectBorrowAccounts(elig, null, 2);
    expect(chosen.map((c) => c.driverId).sort()).toEqual([2, 40]); // 4000(id40) + highest(id2, tgt320)
    expect(pinnedSecondId).toBe(2);
  });

  test('the second account is PINNED — does not rotate when a higher one appears/retires', () => {
    // pinned to driver 2 already; even though driver 9 is now the highest eligible,
    // we keep driver 2 (or drop to just 4000 if 2 is gone) — never switch to 9.
    const elig = [C(9, 400), C(40, 150, true)]; // driver 2 retired; 9 is highest now
    const { chosen } = _selectBorrowAccounts(elig, 2, 2);
    expect(chosen.map((c) => c.driverId)).toEqual([40]); // only 4000 — NOT driver 9
  });

  test('never exceeds two accounts even with many eligible', () => {
    const elig = [C(1, 100), C(2, 320), C(3, 310), C(4, 300), C(40, 200, true)];
    const { chosen } = _selectBorrowAccounts(elig, null, 2);
    expect(chosen.length).toBe(2);
    expect(chosen.some((c) => c.driverId === 40)).toBe(true); // 4000 in
  });

  test('4000 absent → only the pinned highest, still ≤ 2', () => {
    const elig = [C(1, 100), C(2, 320)];
    const { chosen } = _selectBorrowAccounts(elig, null, 2);
    expect(chosen.map((c) => c.driverId)).toEqual([2]);
  });
});

// borrowAllowedInCalm is now the EMERGENCY global stop only (widened defaults).
describe('emergency global stop (borrowAllowedInCalm)', () => {
  const { _borrowAllowedInCalm } = require('../../src/services/monitorService');

  test('normal storm operation is allowed (per-driver gate does the real work)', () => {
    expect(_borrowAllowedInCalm(77, 21.3)).toBe(true);   // the old 07-04 zone — now allowed, per-driver retire protects
    expect(_borrowAllowedInCalm(200, 30)).toBe(true);
  });
  test('only a fleet-wide berserk queue/rate trips the global kill', () => {
    expect(_borrowAllowedInCalm(400, 5)).toBe(false);    // queue past 400
    expect(_borrowAllowedInCalm(100, 60)).toBe(false);   // rate ≥ 60/s
  });
});

// Frozen-landing diagnostics (2026-07-04 display bug): after a fire the live
// queue position only DECAYS (drivers ahead get dispatched), so judging
// on-target from currentPosition paints a phantom undershoot that worsens by
// the minute. #4004 landed 295 vs target 301 (−6, in-band ✓) but the borrowed
// table read the decayed live position 282 and showed ✗ −19.
describe('borrowed-table landing fields use the frozen landing, not the live position', () => {
  const monitor = require('../../src/services/monitorService');

  test('landedPosition / landedOnTarget come from landedPositionToday', () => {
    monitor._setWatch(9001, {
      driverId: 9001, vehicleNumber: '4004', driverName: 'Mushing Nur',
      state: 'in_queue', scheduledPosition: 301,
      positionFiredToday:  true,
      landedPositionToday: 295, // frozen at the bot result
      currentPosition:     282, // live position after front-of-queue dispatches
    });
    const row = monitor.getPositionDiagnostics().find((r) => r.driverId === 9001);
    expect(row.landedPosition).toBe(295);
    expect(row.landedOnTarget).toBe(true); // −6 in-band; the live 282 would say −19 ✗
  });

  test('no frozen landing recorded → fields stay null, never the live position', () => {
    monitor._setWatch(9002, {
      driverId: 9002, vehicleNumber: '9002', driverName: 'x',
      state: 'in_queue', scheduledPosition: 100,
      positionFiredToday: true,
      currentPosition:    60, // decayed — pre-fix this leaked out as landed −40
    });
    const row = monitor.getPositionDiagnostics().find((r) => r.driverId === 9002);
    expect(row.landedPosition).toBe(null);
    expect(row.landedOnTarget).toBe(null);
  });
});

function fakePage(ledger) {
  return {
    evaluate:        jest.fn().mockResolvedValue(true),  // Add click succeeds
    waitForFunction: jest.fn().mockResolvedValue(true),
    // The in-page Remove/confirm clicks take the vehicle out of the queue,
    // just as the real Blazor remove does — so verifyDriverInQueue then null.
    click:           jest.fn(async () => { if (ledger) ledger.inQueue = false; }),
    route:           jest.fn().mockResolvedValue(undefined),
  };
}

/** in-queue ledger the fake bot consults so verifyDriverInQueue is realistic */
function makeBot(ledger) {
  return {
    _SAN_TEXT: {
      ADD_TO_QUEUE_BUTTON: 'Add To Queue',
      REMOVE_FROM_QUEUE:   'Remove From Queue',
      VEHICLE_NOT_AVAILABLE: 'Vehicle Not Available',
    },
    _extractQueueInfo: jest.fn(async () => {
      ledger.inQueue = true;        // the add put us in
      return { position: 130, location: 'V' };
    }),
    getStoredSession:    () => ({}),
    _driveToAddButton:   jest.fn(async () => 'armed'),
    verifyDriverInQueue: jest.fn(async () => (ledger.inQueue ? 130 : null)),
    removeFromQueue:     jest.fn(async () => { ledger.inQueue = false; return { success: true }; }),
  };
}

describe('borrowed probe lifecycle', () => {
  beforeEach(() => {
    probe._borrowedProbes.clear();
    probe._state.dayKey = null;
  });

  test('a borrowed cycle samples the tail (position−1) and ends server-verify removed', async () => {
    const ledger = { inQueue: false };
    const bot    = makeBot(ledger);
    let sampled  = null;
    probe._overrideDeps({
      bot,
      sleep: async () => {},
      now:   () => 1000,
    });

    const p = {
      index: 0, driverId: 7, vehicle: '250', username: 'u', password: 'p',
      borrowed: true, retiring: false, running: false, disabledForDay: false,
      cycles: 0, consecFailures: 0,
      browser: { isConnected: () => true }, context: {}, page: fakePage(ledger), parked: true,
    };
    probe._state.onTailSample = (s) => { sampled = s; };

    const ok = await probe._runCycle(p);
    expect(ok).toBe(true);                 // add + sample + confirmed removal
    expect(sampled).toBe(129);             // 130 − 1 = tail-after-our-removal
    expect(ledger.inQueue).toBe(false);    // guaranteed out of the queue
    expect(bot.removeFromQueue).not.toHaveBeenCalled(); // in-page remove sufficed
  });

  test('retire force-removes a borrowed driver still stuck in queue before handoff', async () => {
    const ledger = { inQueue: true };      // simulate a stuck leftover
    const bot    = makeBot(ledger);
    probe._overrideDeps({ bot, sleep: async () => {}, now: () => 1000 });

    probe._borrowedProbes.set(9, {
      index: 0, driverId: 9, vehicle: '260', username: 'u', password: 'p',
      borrowed: true, retiring: false, running: false, disabledForDay: false,
      cycles: 1, consecFailures: 0, browser: null, context: null, page: null, parked: false,
    });

    await probe._retireBorrowed(9);

    expect(bot.verifyDriverInQueue).toHaveBeenCalledWith('260');
    expect(bot.removeFromQueue).toHaveBeenCalledWith('u', 'p', '260'); // forced clean
    expect(ledger.inQueue).toBe(false);                                // now out
    expect(probe._borrowedProbes.has(9)).toBe(false);                  // freed
  });

  test('syncRoster retires drivers no longer wanted and adds new ones', async () => {
    const ledger = { inQueue: false };
    probe._overrideDeps({ bot: makeBot(ledger), sleep: async () => {}, now: () => 1000 });

    // seed one borrowed driver, then send a roster without it + a new one
    probe._borrowedProbes.set(1, {
      index: 0, driverId: 1, vehicle: '900', username: 'u', password: 'p',
      borrowed: true, retiring: false, running: false, disabledForDay: false,
      cycles: 0, consecFailures: 0, browser: null, context: null, page: null, parked: false,
    });

    probe.syncRoster({
      active: true, dayKey: '2026-07-04',
      roster: [{ driverId: 2, vehicle: '901', username: 'u2', password: 'p2' }],
      onTailSample: () => {},
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(probe._borrowedProbes.has(2)).toBe(true);   // new borrowee added
    expect(probe._borrowedProbes.has(1)).toBe(false);  // dropped one retired
  });

  test('active:false retires every borrowed driver (window closed / monitor stop)', async () => {
    const ledger = { inQueue: false };
    probe._overrideDeps({ bot: makeBot(ledger), sleep: async () => {}, now: () => 1000 });
    probe._borrowedProbes.set(3, {
      index: 0, driverId: 3, vehicle: '902', username: 'u', password: 'p',
      borrowed: true, retiring: false, running: false, disabledForDay: false,
      cycles: 0, consecFailures: 0, browser: null, context: null, page: null, parked: false,
    });

    probe.syncRoster({ active: false, roster: [] });
    await new Promise((r) => setTimeout(r, 5));

    expect(probe._borrowedProbes.has(3)).toBe(false);
  });
});
