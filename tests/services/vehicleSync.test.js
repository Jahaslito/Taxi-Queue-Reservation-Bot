/**
 * Watch vehicle-number sync on cab handover (syncWatchVehicle).
 *
 * 2026-07-13 incident: driver record id=35 was renumbered 0034 → 0026 while the
 * server stayed up. The monitor watch keeps an in-memory snapshot of the
 * vehicle number taken at addWatch, and refreshAutoWatches never re-synced it —
 * so the driver's dashboard card live-tracked physical cab 0034 (V Holding #5 →
 * dispatched → T2 #17…#4 → rejoined #476) all day, while his real cab 0026 sat
 * 400+ positions back. These tests pin:
 *   1. a changed vehicle_number re-points vehicleNumber/vehicleNorm (normalised);
 *   2. every cab-derived observation resets (position, terminal, carryover,
 *      red-zone, tracking) so nothing about the OLD cab leaks onto the new one;
 *   3. day-scoped DRIVER facts survive (positionFiredToday, wasCarryoverToday,
 *      requeue counters) — resetting those could double-fire a position target;
 *   4. an unchanged / cosmetically re-padded number ("0026" vs "26") is a no-op;
 *   5. a bot mid-run keeps its 'requeuing' label so _handleBotResult can settle it.
 *
 * Run: npx jest tests/services/vehicleSync.test.js
 */

jest.mock('../../src/services/schedulerService');
jest.mock('../../src/models/Driver');
jest.mock('../../src/models/Log');
// monitorService requires undici at module top — mock the network boundary so
// requiring the service never touches undici's environment-sensitive internals.
jest.mock('undici', () => ({
  fetch:      jest.fn(async () => ({ ok: true, text: async () => '<html>' })),
  ProxyAgent: jest.fn(),
}));

const monitor = require('../../src/services/monitorService');

// Minimal watch state — the fields syncWatchVehicle touches or must preserve.
function makeState(overrides = {}) {
  return {
    driverId:              35,
    vehicleNumber:         '0034',
    vehicleNorm:           '34',
    state:                 'in_queue',
    hasBeenSeen:           true,
    currentPosition:       448,
    lastPosition:          177,
    landedPositionToday:   177,
    pendingTrackingId:     91,
    atTerminalSince:       new Date(),
    terminalSeen:          true,
    terminalCheckCount:    3,
    terminalName:          'T2',
    terminalPosition:      4,
    terminalLastSeenAt:    new Date(),
    dispatchTerminal:      'T2',
    dispatchNotifyPending: true,
    inQueueFromCarryover:  true,
    carryoverAbsentPolls:  2,
    redzoneRemovePending:  true,
    earlyJoinDetectedAt:   new Date(),
    earlyJoinAtPosition:   14,
    _lastBroadcastPos:     448,
    // Day-scoped driver facts — must SURVIVE the sync
    positionFiredToday:    true,
    wasCarryoverToday:     true,
    requeueCount:          4,
    requeueCountToday:     2,
    ...overrides,
  };
}

describe('syncWatchVehicle — cab handover re-points the watch', () => {
  test('changed number updates vehicleNumber + normalised key and reports true', () => {
    const s = makeState();
    expect(monitor._syncWatchVehicle(s, '0026')).toBe(true);
    expect(s.vehicleNumber).toBe('0026');
    expect(s.vehicleNorm).toBe('26'); // norm() strips leading zeros
  });

  test('all cab-derived observations reset — nothing of the old cab leaks', () => {
    const s = makeState();
    monitor._syncWatchVehicle(s, '0026');

    expect(s.state).toBe('watching');
    expect(s.hasBeenSeen).toBe(false);
    expect(s.currentPosition).toBeNull();
    expect(s.lastPosition).toBeNull();
    expect(s.landedPositionToday).toBeNull();
    expect(s.pendingTrackingId).toBeNull();
    expect(s.atTerminalSince).toBeNull();
    expect(s.terminalSeen).toBe(false);
    expect(s.terminalCheckCount).toBe(0);
    expect(s.terminalName).toBeNull();
    expect(s.terminalPosition).toBeNull();
    expect(s.terminalLastSeenAt).toBeNull();
    expect(s.dispatchTerminal).toBeNull();
    expect(s.dispatchNotifyPending).toBe(false);
    expect(s.inQueueFromCarryover).toBe(false);
    expect(s.carryoverAbsentPolls).toBe(0);
    expect(s.redzoneRemovePending).toBe(false);
    expect(s.earlyJoinDetectedAt).toBeNull();
    expect(s.earlyJoinAtPosition).toBeNull();
    expect(s._lastBroadcastPos).toBeNull();
  });

  test('day-scoped driver facts survive — no double-fire after a handover', () => {
    const s = makeState();
    monitor._syncWatchVehicle(s, '0026');

    expect(s.positionFiredToday).toBe(true);
    expect(s.wasCarryoverToday).toBe(true);
    expect(s.requeueCount).toBe(4);
    expect(s.requeueCountToday).toBe(2);
  });

  test('identical number is a no-op', () => {
    const s = makeState();
    expect(monitor._syncWatchVehicle(s, '0034')).toBe(false);
    expect(s.currentPosition).toBe(448);
    expect(s.state).toBe('in_queue');
  });

  test('cosmetic re-padding ("34" → "0034" → " 0034 ") is a no-op', () => {
    const s = makeState();
    expect(monitor._syncWatchVehicle(s, '34')).toBe(false);
    expect(monitor._syncWatchVehicle(s, ' 0034 ')).toBe(false);
    expect(s.hasBeenSeen).toBe(true);
  });

  test("a bot mid-run keeps 'requeuing' so _handleBotResult can settle it", () => {
    const s = makeState({ state: 'requeuing' });
    monitor._syncWatchVehicle(s, '0026');
    expect(s.state).toBe('requeuing');
    expect(s.vehicleNorm).toBe('26'); // identity still re-points immediately
  });
});
