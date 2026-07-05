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

// Calm-only borrow gate (2026-07-04 safety rail). Defaults: STOP_QUEUE=45,
// STORM_RATE=2/s. Borrowing must be OFF the instant the storm approaches, so a
// lent driver is never held into the burst (the +61/+72/+85 failure).
describe('calm-only borrow gate (borrowAllowedInCalm)', () => {
  const { _borrowAllowedInCalm } = require('../../src/services/monitorService');

  test('deep calm → borrowing allowed', () => {
    expect(_borrowAllowedInCalm(20, 0.5)).toBe(true);
  });
  test('queue at/over onset threshold → mass-retire (no borrowing)', () => {
    expect(_borrowAllowedInCalm(45, 0.5)).toBe(false);
    expect(_borrowAllowedInCalm(77, 0.5)).toBe(false); // the 07-04 storm zone
  });
  test('rate rising (storm onset) → mass-retire even at low queue', () => {
    expect(_borrowAllowedInCalm(30, 2)).toBe(false);
    expect(_borrowAllowedInCalm(30, 21.3)).toBe(false); // the 07-04 spike
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
