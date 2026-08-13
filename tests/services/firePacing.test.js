/**
 * Fire-pacing gate planner (MONITOR_FIRE_PACING). Pure decision logic:
 * given the same-tick fire batch (targets sorted most-overdue first), the live
 * inflight, and the live queue depth, decide which fires to release this tick so
 * inflight stays ≤ PACE_MAX — WITHOUT ever holding a driver past its window.
 *
 * Pins:
 *   1. releases up to (PACE_MAX − inflight) slots, in order (most overdue first);
 *   2. a driver with no runway (queue within URGENCY_MARGIN of target) is ALWAYS
 *      released, even past the cap (holding it only deepens its overshoot);
 *   3. when inflight already ≥ cap, only no-runway drivers fire;
 *   4. small batches under the cap fire entirely (no-op).
 *
 * Thresholds pinned via env before require so the module consts are known.
 * Run: npx jest tests/services/firePacing.test.js
 */

process.env.MONITOR_PACE_MAX_INFLIGHT   = '12';
process.env.MONITOR_PACE_URGENCY_MARGIN = '25';
process.env.MONITOR_PACE_MIN_HOLD       = '5';
process.env.BOT_SESSION_PERSIST_PATH    = '/tmp/fire-pacing-test-sessions.json';

const { _planFirePacing: plan } = require('../../src/services/monitorService');

describe('fire-pacing planner', () => {
  test('small batch under the cap fires entirely (gate is a no-op)', () => {
    // 5 fires, inflight 0, cap 12 → all release. Targets far above queue.
    const r = plan([70, 75, 80, 85, 90], 0, 20);
    expect(r.fired).toBe(5);
    expect(r.held).toBe(0);
    expect(r.releases).toEqual([true, true, true, true, true]);
  });

  test('big same-tick batch is metered to the free slots, most-overdue first', () => {
    // 30 fires, inflight 0, cap 12 → 12 fire, 18 held. Targets far from queue
    // (queue 20, targets ≥ 60) so none are urgent.
    const targets = Array.from({ length: 30 }, (_, i) => 60 + i); // 60..89, none within 25 of queue 20
    const r = plan(targets, 0, 20);
    expect(r.fired).toBe(12);
    expect(r.held).toBe(18);
    expect(r.urgent).toBe(0);
    // The first 12 (lowest targets = most overdue) are the ones released.
    expect(r.releases.slice(0, 12).every(Boolean)).toBe(true);
    expect(r.releases.slice(12).some(Boolean)).toBe(false);
  });

  test('existing inflight shrinks the slots', () => {
    // inflight 8, cap 12 → only 4 slots free.
    const targets = Array.from({ length: 10 }, (_, i) => 100 + i);
    const r = plan(targets, 8, 20);
    expect(r.fired).toBe(4);
    expect(r.held).toBe(6);
  });

  test('concentration gate: a batch that would hold < MIN_HOLD fires releases everyone (calm-morning guard)', () => {
    // inflight 10 (2 slots), 6 far targets → only 4 would hold, which is < 5 →
    // the gate stays out and releases all 6, exactly like `off`.
    const targets = Array.from({ length: 6 }, (_, i) => 200 + i);
    const r = plan(targets, 10, 20);
    expect(r.engaged).toBe(false);
    expect(r.fired).toBe(6);
    expect(r.held).toBe(0);
    expect(r.releases.every(Boolean)).toBe(true);
  });

  test('over a full cap on a real pile-up, ALL no-runway drivers still fire; the rest hold', () => {
    // inflight 12 (0 slots), queue 100. Three urgent (70/80/90 within 25 of 100)
    // plus 15 far targets → 15 holds (≥ MIN_HOLD) so the gate ENGAGES; the urgent
    // three fire over the cap, the far 15 hold.
    const targets = [70, 80, 90, ...Array.from({ length: 15 }, (_, i) => 300 + i)];
    const r = plan(targets, 12, 100);
    expect(r.engaged).toBe(true);
    expect(r.urgent).toBe(3);
    expect(r.fired).toBe(3);
    expect(r.held).toBe(15);
    expect(r.releases.slice(0, 3).every(Boolean)).toBe(true);
    expect(r.releases.slice(3).some(Boolean)).toBe(false);
  });
});
