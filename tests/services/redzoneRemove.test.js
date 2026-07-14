/**
 * Red-zone (SAN "not authorized") auto-remove — detection, throttle & safety.
 *
 * When SAN benches a cab it re-lists the V Holding row as class="notauthorized"
 * (rendered red). The monitor now auto-runs the Remove From Queue bot to pull the
 * cab out so it can rejoin, then verifies on the next poll. These tests pin:
 *   1. parseQueue() routes a notauthorized row into the notAuthorized set;
 *   2. the per-cab throttle (cooldown + daily cap + in-flight) that contains the
 *      ~00:00 carryover churn (SAN re-lists a removed cab within seconds);
 *   3. the SAFETY invariant that killed the fleet on 2026-06-15: the remove must
 *      NEVER mutate carryover / hasBeenSeen protection flags.
 *
 * Run: npx jest tests/services/redzoneRemove.test.js
 */

// ─── Mocks (hoisted before any require) ──────────────────────────────────────
jest.mock('../../src/services/schedulerService');
jest.mock('../../src/models/Driver');
jest.mock('../../src/models/Log');

const { runRemoveBotForDriver } = require('../../src/services/schedulerService');
const Driver  = require('../../src/models/Driver');
const monitor = require('../../src/services/monitorService');

// ─── 1. Detection ─────────────────────────────────────────────────────────────
describe('parseQueue() — red-zone (notauthorized) detection', () => {
  test('a notauthorized row lands in the notAuthorized set, not waiting/dispatched', () => {
    const html = `
      <table>
        <tr class="holdingwaiting"><td style="">12</td><td style="font-weight:bold">4000</td></tr>
        <tr class="notauthorized"><td style="">37</td><td style="font-weight:bold">0113</td></tr>
        <tr class="holdingdispatched"><td style="">3</td><td style="font-weight:bold">0920</td><td>T1</td></tr>
      </table>`;
    const { waiting, dispatched, notAuthorized } = monitor._parseQueue(html);

    expect(notAuthorized.has('113')).toBe(true);   // norm() strips the leading zero
    expect(waiting.has('113')).toBe(false);
    expect(dispatched.has('113')).toBe(false);
    // the other rows are unaffected
    expect(waiting.has('4000')).toBe(true);
    expect(dispatched.has('920')).toBe(true);
  });
});

// ─── 2. Throttle decision ─────────────────────────────────────────────────────
describe('_redzoneRemoveDecision — per-cab churn guard', () => {
  const cfg = { cooldownMs: 90_000, maxPerDay: 6 };
  const NOW = 1_000_000;

  test('fresh cab (no prior attempt) → allowed', () => {
    const d = monitor._redzoneRemoveDecision({}, NOW, cfg);
    expect(d.allow).toBe(true);
  });

  test('a remove already in flight → blocked', () => {
    const d = monitor._redzoneRemoveDecision({ redzoneRemoveInFlight: true }, NOW, cfg);
    expect(d).toEqual({ allow: false, reason: 'in_flight' });
  });

  test('within the cooldown window → blocked', () => {
    const state = { redzoneRemoveLastAttemptMs: NOW - 10_000 }; // 10s ago < 90s
    const d = monitor._redzoneRemoveDecision(state, NOW, cfg);
    expect(d).toEqual({ allow: false, reason: 'cooldown' });
  });

  test('past the cooldown window → allowed again', () => {
    const state = { redzoneRemoveLastAttemptMs: NOW - 91_000 };
    expect(monitor._redzoneRemoveDecision(state, NOW, cfg).allow).toBe(true);
  });

  test('daily cap reached → blocked even after the cooldown', () => {
    const state = { redzoneRemoveCountToday: 6, redzoneRemoveLastAttemptMs: NOW - 200_000 };
    const d = monitor._redzoneRemoveDecision(state, NOW, cfg);
    expect(d).toEqual({ allow: false, reason: 'daily_cap' });
  });
});

// ─── 3. Safety: the remove must not touch protection flags ────────────────────
describe('autoRemoveNotAuthorized — carryover/seen protection is never mutated', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a successful remove leaves inQueueFromCarryover + hasBeenSeen intact and clears in-flight', async () => {
    const driverId = 4242;
    Driver.findByIdWithCredentials.mockResolvedValue({
      id: driverId, is_active: true, san_username: 'u', san_password: 'p',
    });
    runRemoveBotForDriver.mockResolvedValue({ success: true, message: 'removed' });

    // A carryover-protected cab that also got benched into the red zone.
    const state = {
      driverId, vehicleNumber: '0113',
      inQueueFromCarryover: true, hasBeenSeen: true,
      redzoneRemoveInFlight: true,
    };
    monitor._setWatch(driverId, state);

    await monitor._autoRemoveNotAuthorized(driverId, '0113');

    // Correct trigger type (a REMOVE type → can't derive hasBeenSeen)
    expect(runRemoveBotForDriver).toHaveBeenCalledWith(
      expect.objectContaining({ id: driverId }),
      'redzone_auto_remove',
    );
    // Protection flags untouched — this is the 2026-06-15 strand invariant
    expect(state.inQueueFromCarryover).toBe(true);
    expect(state.hasBeenSeen).toBe(true);
    // in-flight guard released so the next poll can retry (subject to cooldown)
    expect(state.redzoneRemoveInFlight).toBe(false);
  });

  test('an inactive / credential-less driver is skipped (no bot run)', async () => {
    const driverId = 4243;
    Driver.findByIdWithCredentials.mockResolvedValue({ id: driverId, is_active: false });
    const state = { driverId, vehicleNumber: '0999', redzoneRemoveInFlight: true };
    monitor._setWatch(driverId, state);

    await monitor._autoRemoveNotAuthorized(driverId, '0999');

    expect(runRemoveBotForDriver).not.toHaveBeenCalled();
    expect(state.redzoneRemoveInFlight).toBe(false); // still released in finally
  });
});
