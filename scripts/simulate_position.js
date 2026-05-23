/**
 * Position scheduling simulation.
 *
 * Simulates a realistic SAN morning surge and shows where each formula
 * would land a driver targeting a given position.
 *
 * Run: node scripts/simulate_position.js
 */

'use strict';

// ─── Simulation config ────────────────────────────────────────────────────────
const POLL_INTERVAL_S    = 30;
const BOT_EXEC_S         = 45;
const SAFETY_BUFFER_S    = 10;
const EMERGENCY_SURGE    = 0.5;  // drivers/second floor
const SHORT_WINDOW_POLLS = 3;

// ─── Simulated queue growth (drivers added per 30-second poll tick) ───────────
// Models a realistic SAN morning: slow start → sharp surge → gradual taper
//              tick: 0  1  2  3   4   5   6   7   8   9  10  11  12  13  14  15
const GROWTH_PER_TICK = [
   3,  4,  5,  6,   8,  10,  14,  20,  28,  35,  30,  25,  22,  18,  15,  12,
  10,  9,  8,  7,   6,   5,   5,   4,   4,   3,   3,   2,   2,   2,
];

// ─── Targets to simulate ──────────────────────────────────────────────────────
const TARGETS = [90, 115, 150, 200];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Formula implementations ──────────────────────────────────────────────────

/** OLD formula (pre all changes): EMA α=0.5 on per-tick deltas, fixed 2.5× multiplier, floor=5 */
function oldFormula(queue, prevQueue, smoothed, pollInterval) {
  const raw     = Math.max(0, queue - prevQueue);
  const newSmoothed = smoothed * 0.5 + raw * 0.5;
  const effective   = Math.max(raw, newSmoothed);
  const drift       = Math.max(5, Math.ceil(effective * 2.5));
  return { drift, smoothed: newSmoothed, effective };
}

/** NEW formula: real poll age, 3-poll window, emergency surge, EMA α=0.7, safety buffer */
function newFormula(queue, observations, smoothedRate, pollAgeS) {
  const prev = observations.length >= 2 ? observations[observations.length - 2] : null;

  let lastPollRate  = EMERGENCY_SURGE;
  let shortWindowRate = 0;

  if (prev) {
    const secElapsed = Math.max(1, (observations[observations.length - 1].t - prev.t));
    lastPollRate     = Math.max(0, (queue - prev.count) / secElapsed);
  }

  if (observations.length >= SHORT_WINDOW_POLLS) {
    const oldest   = observations[observations.length - SHORT_WINDOW_POLLS];
    const latest   = observations[observations.length - 1];
    const windowS  = Math.max(1, latest.t - oldest.t);
    shortWindowRate = Math.max(0, (queue - oldest.count) / windowS);
  }

  const newSmoothed = smoothedRate * 0.3 + lastPollRate * 0.7;

  const effectiveRate = Math.max(
    lastPollRate,
    shortWindowRate,
    newSmoothed,
    EMERGENCY_SURGE,
  );

  const horizonS   = pollAgeS + BOT_EXEC_S + SAFETY_BUFFER_S;
  const drift      = Math.max(20, Math.ceil(effectiveRate * horizonS));

  return { drift, smoothed: newSmoothed, effectiveRate, horizonS };
}

// ─── Run simulation for one target ───────────────────────────────────────────
function simulate(targetPosition) {
  let queue        = 0;
  let oldSmoothed  = 0;
  let newSmoothed  = 0;
  const observations = [];

  let oldFiredAt   = null; // { tick, queue }
  let newFiredAt   = null;

  const rows = [];

  for (let tick = 0; tick < GROWTH_PER_TICK.length; tick++) {
    const prevQueue = queue;
    queue += GROWTH_PER_TICK[tick];

    const timeS = tick * POLL_INTERVAL_S;
    // Real clock time: simulation starts at 5:00 AM, each tick is POLL_INTERVAL_S seconds
    const totalMins = 5 * 60 + Math.floor(timeS / 60);
    const timeFmt = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;

    // Maintain observation buffer
    observations.push({ count: queue, t: timeS });
    if (observations.length > SHORT_WINDOW_POLLS + 1) observations.shift();

    // ── OLD formula ──
    let oldProjected = null;
    if (!oldFiredAt && prevQueue !== null) {
      const { drift, smoothed } = oldFormula(queue, prevQueue, oldSmoothed, POLL_INTERVAL_S);
      oldSmoothed  = smoothed;
      oldProjected = queue + drift;
      if (oldProjected >= targetPosition) {
        oldFiredAt = { tick, queue, drift, pollAgeS: POLL_INTERVAL_S * 0.5 };
      }
    }

    // ── NEW formula ──
    let newProjected = null;
    if (!newFiredAt) {
      const pollAgeS = tick === 0 ? POLL_INTERVAL_S : (POLL_INTERVAL_S * 0.5); // avg mid-interval
      const { drift, smoothed, effectiveRate, horizonS } = newFormula(queue, observations, newSmoothed, pollAgeS);
      newSmoothed  = smoothed;
      newProjected = queue + drift;
      if (newProjected >= targetPosition) {
        newFiredAt = { tick, queue, drift, effectiveRate, horizonS, pollAgeS };
      }
    }

    rows.push({
      tick,
      timeFmt,
      queue,
      growth: GROWTH_PER_TICK[tick],
      oldProjected,
      newProjected,
      oldFired: oldFiredAt?.tick === tick,
      newFired: newFiredAt?.tick === tick,
    });
  }

  // ── Calculate actual landing positions ──────────────────────────────────────
  // Drivers keep joining from the moment the observation was taken until the bot finishes.
  // Actual elapsed = pollAgeS (data was already stale when read) + BOT_EXEC_S (bot run time).
  // Safety buffer is NOT included — it is a conservative trigger margin, not real elapsed time.
  function actualLanding(firedAt) {
    if (!firedAt) return null;
    const tick         = firedAt.tick;
    const growthAtFire = GROWTH_PER_TICK[tick] ?? GROWTH_PER_TICK[GROWTH_PER_TICK.length - 1];
    const ratePerSec   = growthAtFire / POLL_INTERVAL_S;
    const pollAgeS     = firedAt.pollAgeS ?? POLL_INTERVAL_S * 0.5;
    const actualElapsedS = pollAgeS + BOT_EXEC_S;   // e.g. 15 + 45 = 60s
    const duringDelay  = Math.round(ratePerSec * actualElapsedS);
    return firedAt.queue + duringDelay;
  }

  const oldLanding = actualLanding(oldFiredAt);
  const newLanding = actualLanding(newFiredAt);

  return { targetPosition, rows, oldFiredAt, newFiredAt, oldLanding, newLanding };
}

// ─── Print results ────────────────────────────────────────────────────────────
function printResult(result) {
  const { targetPosition, rows, oldFiredAt, newFiredAt, oldLanding, newLanding } = result;

  console.log(`\n${'═'.repeat(72)}`);
  console.log(` TARGET POSITION: ${targetPosition}`);
  console.log('═'.repeat(72));
  console.log(' Time   Queue  +/tick  │  OLD projected  │  NEW projected ');
  console.log('────────────────────────┼─────────────────┼────────────────');

  for (const r of rows) {
    const oldProj = r.oldProjected != null ? String(Math.round(r.oldProjected)).padStart(5) : '     ';
    const newProj = r.newProjected != null ? String(Math.round(r.newProjected)).padStart(5) : '     ';
    const oldTag  = r.oldFired ? ' ◄ FIRE' : '       ';
    const newTag  = r.newFired ? ' ◄ FIRE' : '       ';
    console.log(
      ` ${r.timeFmt}  ${String(r.queue).padStart(4)}    +${String(r.growth).padStart(2)}  │ ${oldProj}${oldTag}  │ ${newProj}${newTag}`,
    );
  }

  console.log('─'.repeat(72));

  if (oldFiredAt) {
    const diff = oldLanding - targetPosition;
    const sign = diff > 0 ? '+' : '';
    console.log(` OLD formula  → fired at queue ${oldFiredAt.queue.toString().padStart(4)} (tick ${oldFiredAt.tick}) → landed at ${oldLanding}  (${sign}${diff} from target)`);
  } else {
    console.log(` OLD formula  → never fired in this window`);
  }

  if (newFiredAt) {
    const diff = newLanding - targetPosition;
    const sign = diff > 0 ? '+' : '';
    console.log(` NEW formula  → fired at queue ${newFiredAt.queue.toString().padStart(4)} (tick ${newFiredAt.tick}) → landed at ${newLanding}  (${sign}${diff} from target)`);
    console.log(`               rate: ${newFiredAt.effectiveRate.toFixed(2)}/s, horizon: ${Math.round(newFiredAt.horizonS)}s, drift: ${newFiredAt.drift}`);
  } else {
    console.log(` NEW formula  → never fired in this window`);
  }
  console.log('═'.repeat(72));
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log('\n  SAN QUEUE — POSITION SCHEDULING SIMULATION');
console.log('  Morning surge: 5:00 AM start, peak ~5:04 AM (tick 9 · 30s intervals)');
console.log(`  Poll: ${POLL_INTERVAL_S}s | Bot exec: ${BOT_EXEC_S}s | Safety buffer: ${SAFETY_BUFFER_S}s | Emergency surge floor: ${EMERGENCY_SURGE}/s\n`);

for (const target of TARGETS) {
  printResult(simulate(target));
}
