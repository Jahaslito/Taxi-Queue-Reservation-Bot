/**
 * Sacrificial tail probe — MULTI-VEHICLE interleaving.
 *
 * Two probe accounts halve the sampling gap (replay: 88% ≤ +15 at one probe's
 * ~3.5 s cycle → 94% at ~1.8 s). These tests pin the multi-probe rails: both
 * loops run to their PER-PROBE caps, a collision on ANY probe vehicle refuses
 * everything, and one probe's failure-disable never stops the other.
 *
 * Env is read at module load; Jest isolates the registry per file, so this
 * file configures two probes without touching the single-probe suite.
 */

process.env.MONITOR_TAIL_PROBE        = '1';
process.env.TAIL_PROBE_VEHICLE        = '9998,9999';
process.env.TAIL_PROBE_SAN_USERNAME   = 'probe-a,probe-b';
process.env.TAIL_PROBE_SAN_PASSWORD   = 'pass-a,pass-b';
process.env.TAIL_PROBE_MAX_CYCLES     = '3';
process.env.TAIL_PROBE_MAX_FAILURES   = '2';
process.env.TAIL_PROBE_CYCLE_PAUSE_MS = '1';
process.env.TAIL_PROBE_STAGGER_MS     = '1';

const probe = require('../../src/services/tailProbeService');

function fakePage() {
  return {
    evaluate:        jest.fn().mockResolvedValue(true),
    waitForFunction: jest.fn().mockResolvedValue(true),
    click:           jest.fn().mockResolvedValue(undefined),
    route:           jest.fn().mockResolvedValue(undefined),
  };
}

/** Per-vehicle bot stub: `stuckVehicles` never leave the queue (their cycles
 *  fail); everyone else removes cleanly on the first verify. */
function fakeBot({ position = 120, stuckVehicles = [] } = {}) {
  return {
    _SAN_TEXT: {
      ADD_TO_QUEUE_BUTTON: 'Add To Queue',
      REMOVE_FROM_QUEUE:   'Remove From Queue',
      VEHICLE_NOT_AVAILABLE: 'Vehicle Not Available',
    },
    _driveToAddButton: jest.fn().mockResolvedValue('armed'),
    _extractQueueInfo: jest.fn().mockResolvedValue({ position, location: 'V Holding' }),
    verifyDriverInQueue: jest.fn().mockImplementation(async (vehicle) =>
      stuckVehicles.includes(String(vehicle)) ? { position, location: 'V Holding' } : null),
    removeFromQueue:  jest.fn().mockResolvedValue({ success: true, removed: true }),
    getStoredSession: jest.fn().mockReturnValue(undefined),
  };
}

function fakeChromium() {
  return {
    launch: jest.fn().mockImplementation(async () => ({
      isConnected: () => true,
      close:       jest.fn().mockResolvedValue(undefined),
      newContext:  jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(fakePage()),
      }),
    })),
  };
}

function resetState(dayKey = '2026-07-03') {
  Object.assign(probe._state, {
    desired: false, dayKey, samples: 0,
    lastSamplePos: null, lastSampleAt: 0, onTailSample: null,
    collisionWarned: false,
  });
  for (const p of probe._probes) {
    Object.assign(p, {
      running: false, disabledForDay: false, cycles: 0, consecFailures: 0,
      browser: null, context: null, page: null, parked: false,
    });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  resetState();
  probe._overrideDeps({ sleep: () => Promise.resolve(), now: () => 1000 });
});

test('two probes parse from comma lists and both run to their per-probe caps', async () => {
  probe._overrideDeps({ bot: fakeBot(), chromium: fakeChromium() });
  const samples = [];
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(['4007']),
    onTailSample: (p) => samples.push(p),
  });
  await flush();

  expect(probe._probes).toHaveLength(2);
  expect(probe._probes[0].cycles).toBe(3);          // per-probe cap, not shared
  expect(probe._probes[1].cycles).toBe(3);
  expect(samples.length).toBeGreaterThanOrEqual(4); // both fed the same consumer
  for (const s of samples) expect(s).toBe(119);     // position − 1, both probes
  const stats = probe.tailProbeStats();
  expect(stats.cycles).toBe(6);                     // aggregate
  expect(stats.probes.map((p) => p.vehicle)).toEqual(['9998', '9999']);
});

test('collision on ANY probe vehicle refuses the whole probe', async () => {
  const onTailSample = jest.fn();
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(['9999']),              // second probe's vehicle
    onTailSample,
  });
  await flush();
  expect(probe._probes[0].running).toBe(false);
  expect(probe._probes[1].running).toBe(false);
  expect(onTailSample).not.toHaveBeenCalled();
});

test('one probe failure-disables (with rescue remove) while the other keeps sampling', async () => {
  const botStub = fakeBot({ stuckVehicles: ['9998'] }); // probe A never removes → fails
  probe._overrideDeps({ bot: botStub, chromium: fakeChromium() });
  const samples = [];
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(),
    onTailSample: (p) => samples.push(p),
  });
  await flush();

  expect(probe._probes[0].disabledForDay).toBe(true);   // A: 2 consecutive failures
  expect(botStub.removeFromQueue).toHaveBeenCalledWith('probe-a', 'pass-a', '9998');
  expect(probe._probes[1].disabledForDay).toBe(false);  // B: unaffected…
  expect(probe._probes[1].cycles).toBe(3);              // …ran to its own cap
  expect(samples.length).toBeGreaterThan(0);            // and kept feeding samples
});
