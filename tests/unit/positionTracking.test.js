/**
 * PositionTracking — computeFilteredMedian
 *
 * Tests the pure helper that backs medianRecentError. The whole reason this
 * helper exists is to keep the outlier filter and median math trivially
 * testable without a DB connection — keep the assertions tight and named so
 * a future regression is easy to pinpoint.
 *
 * Run: npx jest tests/unit/positionTracking.test.js
 */

const PositionTracking = require('../../src/models/PositionTracking');
const median = PositionTracking._computeFilteredMedian;

describe('computeFilteredMedian — bias signal cleaning', () => {
  test('returns null when fewer than MIN_BIAS_SAMPLES inputs', () => {
    expect(median([1, 2, 3, 4])).toBeNull();
  });

  test('returns null when MIN samples but all filtered as outliers', () => {
    expect(median([100, -100, 200, -200, 300])).toBeNull();
  });

  test('exact median for odd-length filtered set', () => {
    expect(median([-5, -2, 0, 2, 5])).toBe(0);
  });

  test('mean of two middles for even-length filtered set', () => {
    expect(median([-4, -2, 2, 4, 6, 8])).toBe((2 + 4) / 2);
  });

  test('discards |error| > outlierMax (default 30)', () => {
    // Real fires: -3, 1, -5, 4, 2 → median 1
    // One contamination event at -117 (the 2026-05-27 #142 case).
    // Without filtering, median would be -3 → would push bias hard negative
    // and cause the +62 #695 overshoot. With filtering, the outlier is
    // dropped and median stays at 1.
    expect(median([-117, -3, 1, -5, 4, 2])).toBe(1);
  });

  test('respects custom outlierMax', () => {
    // With a tight outlierMax=5 we drop the 10 too:
    //   [-5, -3, 1, 2, 4] → median 1
    expect(median([10, -5, -3, 1, 2, 4], { outlierMax: 5 })).toBe(1);
  });

  test('ignores non-finite inputs', () => {
    expect(median([NaN, Infinity, -5, -2, 0, 2, 5])).toBe(0);
  });

  test('boundary: |error| === outlierMax is kept', () => {
    // 30 should be inside the gate (≤30), so median = 0
    expect(median([-30, -5, 0, 5, 30])).toBe(0);
  });
});

// ─── describeOutcome — exact-cause labels for the report ──────────────────────
describe('describeOutcome — report status from decision/reason', () => {
  const out = PositionTracking.describeOutcome;

  test('landed: actual recorded → ok', () => {
    expect(out({ decision: 'fired', target_position: 100, actual_position: 104 }))
      .toMatchObject({ status: 'landed', tone: 'ok' });
  });

  test('locked out → bad', () => {
    expect(out({ decision: 'skip_locked_out' })).toMatchObject({ status: 'locked_out', tone: 'bad' });
  });

  test('already in queue (skip_already_seen and already_queued) → warn', () => {
    expect(out({ decision: 'skip_already_seen' })).toMatchObject({ status: 'already_in_queue' });
    expect(out({ decision: 'already_queued' })).toMatchObject({ status: 'already_in_queue' });
  });

  test('missed_impossible → missed/bad', () => {
    expect(out({ decision: 'missed_impossible', decision_reason: 'queue_already_past_max' }))
      .toMatchObject({ status: 'missed', tone: 'bad' });
  });

  test('failed → not eligible vs bad credentials vs generic', () => {
    expect(out({ decision: 'failed', decision_reason: 'SAN says this vehicle is not currently eligible' }))
      .toMatchObject({ status: 'not_eligible' });
    expect(out({ decision: 'failed', decision_reason: 'Invalid SAN username or password' }))
      .toMatchObject({ status: 'bad_credentials' });
    expect(out({ decision: 'failed', decision_reason: 'something odd' }))
      .toMatchObject({ status: 'failed' });
  });

  test('wait → carryover vs generic waiting', () => {
    expect(out({ decision: 'wait', decision_reason: 'awaiting_overnight_purge' }))
      .toMatchObject({ status: 'carryover' });
    expect(out({ decision: 'wait', decision_reason: 'projected_below_target' }))
      .toMatchObject({ status: 'waiting' });
  });

  test('fired with no actual → in_flight (genuine pending), NOT a blank', () => {
    const r = out({ decision: 'fired' });
    expect(r.status).toBe('in_flight');
    expect(r.label).toBeTruthy();
  });
});
