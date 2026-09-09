/**
 * Regression: the ladder velocity gate must not self-throttle on its own adds.
 *
 * 2026-09-07 live bug: 11 seeds fired 04:00:34–39. `ladderAddsCommitted` (the
 * "ours" counter subtracted to get EXTERNAL velocity) stepped up at FIRE, but the
 * displayed queue only rose ~5 s later at COMMIT. Once the fire-time step slid out
 * of the 8 s velocity window while the commit-rise was still inside it, our OWN 11
 * adds read as external growth → observedVelocity spiked to ~1.0/s → LADDER_MAX_VEL
 * tripped → seeding shut off for the rest of the calm window (11 placed, not ~30).
 *
 * Fix (MONITOR_OURS_AT_COMMIT, default on): count `ours` at COMMIT, in lockstep
 * with the queue rise it causes, so our adds cancel exactly. This test drives the
 * real observedVelocity primitives with a ZERO-external-growth timeline: every
 * position of the 10→21 rise is our own 11 seeds. Fire-timing reports pure self-
 * throttle; commit-timing reports the true external velocity (0).
 */
process.env.MONITOR_PRED_VEL_WINDOW = '8';   // s, trailing velocity window
process.env.MONITOR_PRED_VEL_CAP    = '2.5';
process.env.MONITOR_LADDER_MAX_VEL  = '0.5'; // /s — the ladder shutoff threshold

const MAX_VEL = 0.5;

// Replay the 09-07 shape. `bumpAt` = when the 11 "ours" adds are counted.
//   fire   → all 11 counted up front (the old bug)
//   commit → counted as each lands, in lockstep with the queue rise (the fix)
function selfVelocity(bumpAt) {
  jest.resetModules();
  const m = require('../../src/services/monitorService.js');
  const t0 = 1_000_000;

  if (bumpAt === 'fire') m._bumpLadderAdds(11);
  m._recordVelocityObservation(10, t0);            // baseline: queue 10, calm

  // Our 11 seeds COMMIT over the next 5 s, raising the displayed queue 10 → 21.
  // External growth is ZERO — every added position is one of ours.
  const commits = [ [t0 + 2000, 14, 4], [t0 + 4000, 17, 7], [t0 + 5000, 21, 11] ];
  let counted = bumpAt === 'fire' ? 11 : 0;
  for (const [t, q, landed] of commits) {
    if (bumpAt === 'commit') { m._bumpLadderAdds(landed - counted); counted = landed; }
    m._recordVelocityObservation(q, t);
  }

  // One window (8 s) after the fire: external is still dead calm.
  m._recordVelocityObservation(21, t0 + 8000);
  return m._observedVelocity(t0 + 8000);
}

describe('ours accounting timing — ladder self-throttle regression', () => {
  test('FIRE-timed accounting mis-reads our own commit-rise as external → trips the gate', () => {
    expect(selfVelocity('fire')).toBeGreaterThan(MAX_VEL);
  });

  test('COMMIT-timed accounting cancels our adds → velocity stays calm (no self-throttle)', () => {
    expect(selfVelocity('commit')).toBeLessThanOrEqual(MAX_VEL);
  });

  test('with zero external growth, commit-timing reports ~0 velocity', () => {
    expect(selfVelocity('commit')).toBeCloseTo(0, 5);
  });
});

/**
 * Regression: the onset RATE gate must not self-trigger on our own commit BURST.
 *
 * 2026-09-08 live bug ("Alarm 2"): even with commit-timed `ours`, the onset detector
 * still declared a FALSE storm. The STEP path already subtracts the instantaneous
 * ownStep, but the RATE path subtracted the 8 s-WINDOWED ownAddRate (~1/s) from an
 * INSTANTANEOUS effectiveGrowthRate that spikes to ~5/s on the single poll where a
 * seed burst commits. A windowed rate can't cancel a one-poll spike → onset armed at
 * q22 "5.00/s" purely on our own 4 commits and shut the ladder off all storm.
 *
 * Fix (MONITOR_ONSET_OWN_RATE_FIX, default on): onsetStep also subtracts the
 * instantaneous own rate (ownStep ÷ dt), matched to the spike's timescale. Below, the
 * +5 render step is entirely ours (ownStep 4) so the STEP path is already passive —
 * isolating the RATE path as the ONLY decider: it flips the outcome with the flag.
 */
function onsetActiveAfterOwnBurst({ fix, ownDelta }) {
  jest.resetModules();
  process.env.MONITOR_ONSET_FIRE         = '1';
  process.env.MONITOR_ONSET_ZONE_MIN     = '20';
  process.env.MONITOR_ONSET_ZONE_MAX     = '90';
  process.env.MONITOR_ONSET_RATE         = '1.2';
  process.env.MONITOR_ONSET_STEP         = '5';
  process.env.MONITOR_ONSET_OWN_RATE_FIX = fix ? '1' : '0';
  const m = require('../../src/services/monitorService.js');
  const T0 = 1_000_000;
  const fresh = { active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0 };
  // Prime: queue 17, ours 8 (calm, in zone).
  let st = m._onsetStep(fresh, { queue: 17, rate: 0.2, nowMs: T0, ours: 8, ownWindowRate: 0, dt: 1 });
  // Spike poll: displayed queue 17 → 22 (+5 raw, 5/s). `ownDelta` of that +5 is ours.
  st = m._onsetStep(st, {
    queue: 22, rate: 5.0, nowMs: T0 + 1000,
    ours: 8 + ownDelta, ownWindowRate: 0.5, dt: 1,
  });
  return st.active;
}

describe('onset own-rate fix — the 09-08 false self-onset', () => {
  test('our OWN commit burst (all +5 is ours) does NOT arm onset with the fix on', () => {
    expect(onsetActiveAfterOwnBurst({ fix: true, ownDelta: 4 })).toBe(false);
  });

  test('flag off reproduces the bug: the same own burst arms onset via the rate path', () => {
    expect(onsetActiveAfterOwnBurst({ fix: false, ownDelta: 4 })).toBe(true);
  });

  test('a REAL external +5 (none of it ours) still arms onset with the fix on', () => {
    expect(onsetActiveAfterOwnBurst({ fix: true, ownDelta: 0 })).toBe(true);
  });
});
