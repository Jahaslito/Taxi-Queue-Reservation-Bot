/**
 * Sacrificial tail probe — state-machine tests (no browser).
 *
 * The probe's page work is exercised in production smoke tests; here we pin
 * the safety rails: gating, day rollover, the daily cycle cap, the
 * consecutive-failure disable + rescue remove, and the watched-vehicle
 * collision guard. Deps are injected via _overrideDeps; runCycle is driven
 * through a stubbed botService.
 */

process.env.MONITOR_TAIL_PROBE       = '1';
process.env.TAIL_PROBE_VEHICLE       = '9999';
process.env.TAIL_PROBE_SAN_USERNAME  = 'probe-user';
process.env.TAIL_PROBE_SAN_PASSWORD  = 'probe-pass';
process.env.TAIL_PROBE_MAX_CYCLES    = '5';
process.env.TAIL_PROBE_MAX_FAILURES  = '2';
process.env.TAIL_PROBE_CYCLE_PAUSE_MS = '1';

const probe = require('../../src/services/tailProbeService');

// Minimal fake WAIT-screen page: every evaluate/click/waitForFunction succeeds.
function fakePage() {
  return {
    evaluate:        jest.fn().mockResolvedValue(true),
    waitForFunction: jest.fn().mockResolvedValue(true),
    click:           jest.fn().mockResolvedValue(undefined),
    route:           jest.fn().mockResolvedValue(undefined),
  };
}

function fakeBot({ position = 120, removedAfter = 1 } = {}) {
  let verifyCalls = 0;
  return {
    _SAN_TEXT: {
      ADD_TO_QUEUE_BUTTON: 'Add To Queue',
      REMOVE_FROM_QUEUE:   'Remove From Queue',
      VEHICLE_NOT_AVAILABLE: 'Vehicle Not Available',
    },
    _driveToAddButton: jest.fn().mockResolvedValue('armed'),
    _extractQueueInfo: jest.fn().mockResolvedValue({ position, location: 'V Holding' }),
    _isWaitScreen:     jest.fn().mockResolvedValue(false),
    verifyDriverInQueue: jest.fn().mockImplementation(async () => {
      verifyCalls++;
      return verifyCalls >= removedAfter ? null : { position, location: 'V Holding' };
    }),
    removeFromQueue:  jest.fn().mockResolvedValue({ success: true, removed: true }),
    getStoredSession: jest.fn().mockReturnValue(undefined),
  };
}

function fakeChromium(page) {
  return {
    launch: jest.fn().mockResolvedValue({
      isConnected: () => true,
      close:       jest.fn().mockResolvedValue(undefined),
      newContext:  jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(page),
      }),
    }),
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

const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  resetState();
  probe._overrideDeps({ sleep: () => Promise.resolve(), now: () => 1000 });
});

test('inactive sync never starts the loop', async () => {
  probe.sync({ active: false, dayKey: '2026-07-03', onTailSample: jest.fn() });
  await flush();
  expect(probe._probes[0].running).toBe(false);
  expect(probe._probes[0].cycles).toBe(0);
});

test('watched-vehicle collision refuses to run', async () => {
  const onTailSample = jest.fn();
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(['9999']),
    onTailSample,
  });
  await flush();
  expect(probe._probes[0].running).toBe(false);
  expect(onTailSample).not.toHaveBeenCalled();
});

test('active loop samples the tail as position−1 and respects the daily cap', async () => {
  const page = fakePage();
  const botStub = fakeBot({ position: 120, removedAfter: 1 });
  probe._overrideDeps({ bot: botStub, chromium: fakeChromium(page) });

  const samples = [];
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(['4007']),
    onTailSample: (p) => samples.push(p),
  });
  await flush();

  // cap = 5 cycles; every sample must be landed − 1 (tail after our removal)
  expect(probe._probes[0].cycles).toBe(5);
  expect(probe._probes[0].running).toBe(false);
  expect(samples.length).toBeGreaterThan(0);
  for (const s of samples) expect(s).toBe(119);
});

test('consecutive failures disable for the day and run the rescue remove', async () => {
  const page = fakePage();
  // add click "succeeds" but the vehicle NEVER leaves the queue → cycle fails
  const botStub = fakeBot({ position: 80, removedAfter: 999 });
  probe._overrideDeps({ bot: botStub, chromium: fakeChromium(page) });

  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(),
    onTailSample: jest.fn(),
  });
  await flush();

  expect(probe._probes[0].disabledForDay).toBe(true);
  expect(probe._probes[0].consecFailures).toBe(2);
  expect(botStub.removeFromQueue).toHaveBeenCalledWith('probe-user', 'probe-pass', '9999');
  // day rollover re-arms it
  probe.sync({ active: false, dayKey: '2026-07-04' });
  expect(probe._probes[0].disabledForDay).toBe(false);
  expect(probe._probes[0].cycles).toBe(0);
});

test('stats reflect the run', async () => {
  const page = fakePage();
  probe._overrideDeps({ bot: fakeBot(), chromium: fakeChromium(page) });
  probe.sync({
    active: true, dayKey: '2026-07-03',
    watchedVehicles: new Set(),
    onTailSample: jest.fn(),
  });
  await flush();
  const s = probe.tailProbeStats();
  expect(s.enabled).toBe(true);
  expect(s.configured).toBe(true);
  expect(s.cycles).toBeGreaterThan(0);
  expect(s.samples).toBeGreaterThan(0);
  expect(s.lastSamplePos).toBe(119);
});
