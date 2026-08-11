# Overshoot fix — predictive velocity×latency lead

**Status:** IMPLEMENTED, default OFF (`MONITOR_PREDICTIVE_LEAD=0`). Validated in
simulation across 8 storm days (5 with full instrumentation + 3 out-of-sample). Code lives
in `botService.js` (`currentInflight`) and `monitorService.js` (velocity buffer + the
lead computation in `evaluatePositionScheduler`); behavior locked by tests in
`tests/services/monitor.test.js` ("predictive velocity×latency lead"). Not yet enabled on a
live storm.
**Author's note:** every number below is reproducible from `logs/` with the harness in
the scratchpad (`parse.js`, `real_velocity.js`, `retune_real.js`). Velocity is taken from
the **real logged V Holding stream**, not a reconstruction.

---

## TL;DR

Storm overshoot is caused by the queue moving underneath us during SAN's commit latency,
while our lead is hard-clamped to 10 and cannot cover it. The fix is to size the lead to
the drift we can actually measure at click time:

```
D = clamp( velocity × predicted_latency , 0 , 40 )
predicted_latency = 5 + 0.25 × inflight_at_dispatch     (seconds)
velocity          = trailing-8s slope of observed V Holding depth, capped 2.5/s
fire when observed_queue ≥ target − D
```

Simulated effect across the 5 fully-instrumented days (velocity from real V Holding):

| | ±10 in-band | >+40 overshoot | median | undershoot <−10 |
|---|---|---|---|---|
| **Actual (today's system)** | 37.6% | 13.2% | +16 | 0.2% |
| **Predictive lead** | **75.9%** | **1.5%** | **+1** | 6% |

In-band doubles, the overshoot tail (the acute complaint) is crushed, and the median
centers — at the cost of a controlled 6% undershoot.

---

## 1. The problem

`2026-08-05` landed **±10 = 27.3%, >+40 = 22.7%, worst +65, median +19**. The five most
recent storm days averaged 37.6% in-band with a 13.2% heavy-overshoot tail and a
persistently **positive median (+10…+24 every day)** — a systematic *late* bias.

## 2. Root cause — drift during commit latency

Per fire, define `drift = landed − queueAtFire` = how far the queue moved between our
click and SAN stamping the slot. The identity that governs every landing is:

```
error = landed − target = drift − lead        (exact; identity-checked on all days)
```

- **`error` vs `latency`: r = 0.79.** Overshoot is a latency phenomenon.
- **`error` vs "fired early": r = 0.03.** Firing early is *not* the problem — the lead is
  the problem.
- Landings sat on average **+33 above queue-at-fire**; the lead was clamped at 10. The
  ~+23 gap is the overshoot.

There is a sharp **latency cliff**: fires committing in <5s were 100% in-band; 5–8s → 79%;
8–11s → 7%; 14s+ → 0%. On 08-05 the median commit latency was 10.4s.

Latency itself is `≈ 5.6 + 0.2 × inflight` (fit; the exogenous ~5s floor is airport-wide
storm load we cannot remove; the slope is our own concurrency). That floor is why
*reducing* latency can't save us — but *predicting* the resulting drift and leading by it
can.

## 3. What we ruled out (with simulation evidence, so we don't repeat dead ends)

- **Inflight pacing / concurrency cap — FALSIFIED, actively harmful.** Capping concurrent
  fires to 10 sends >+40 from 13% to **65%** and median to +77. Mechanism: 88 fires want
  the same ~10s window; a cap forces ~8 sequential waves, and the storm queue climbs ~+180
  while they drain. The delay adds far more drift than the reduced latency removes.
- **Flat bigger lead (POS_MAX_LEAD 15/20/25) — no fixed value works across days.** D=20 →
  0% overshoot but 40% undershoot; the right lead varies by day and within the day.
- **Rate-scaled projection lead — already rejected** (POS_MAX_LEAD=50, 08-05): the rate
  estimate runs 3–5.6× hot, so a rate-scaled lead undershoots on a third of fires.
- **Within-storm feedback from our own landings — too slow.** Drift is highly persistent
  (autocorrelation 0.84–0.90), but in a compressed storm every fire clicks before any of
  them commits, so the feedback never arrives in time (causal test: 25–28%, worse than
  actual).

## 4. The solution

The one predictor available *at click time* that tracks drift is **velocity × latency**,
because `drift = ∫velocity dt over the commit window ≈ velocity × latency`. Correlation
with realized drift: **0.78**. Both inputs are observable the instant we decide:

- **velocity** — trailing 8s slope of the V Holding depth the monitor already polls,
  capped at 2.5/s (robust against one-tick spikes — the "hot rate" trap).
- **predicted_latency** = `5 + 0.25 × inflight_at_dispatch`. `inflight_at_dispatch` is the
  count of our fires clicked-but-not-yet-committed — already computed as
  `pendingFireVis.size` (`botService.inFlightAtDispatch`).

```
D = clamp( velocity × (5 + 0.25 × inflight) , 0 , 40 )
fire when   observed_queue ≥ target − D
```

**Why this is safe where the others weren't:** it is neither a delay (no pacing) nor a
fixed lead nor the hot rate. It reads live velocity *and* live inflight, so when it fires
into a calmer moment both inputs shrink and `D` shrinks with them — it self-corrects for
the very re-timing effect that a replay can't fully model.

## 5. Simulation results

Method: the identity-anchored per-fire transform `error = drift − D` (reproduces each
day's actual to the exact position when D = the actual lead). Velocity from the **real
logged V Holding** stream. Config below is fixed constants — no per-day fitting.

Config: `W=8s, velCap=2.5/s, leadCap=40, latency = 5 + 0.25·inflight`.

| Day | Actual ±10 / >+40 / med | Predictive ±10 / >+40 / <−10 / med |
|---|---|---|
| 08-01 | 41.3% / 7.5% / +14 | 82.5% / 0% / 3.8% / +1 |
| 08-02 | 25.3% / 3.6% / +24 | 86.7% / 0% / 4.8% / +2 |
| 08-03 | 44.8% / 31% / +11 | 65.5% / 3.4% / 1.7% / +3 |
| 08-04 | 50.5% / 6.5% / +10 | 79.6% / 0% / 7.5% / −1 |
| 08-05 | 27.3% / 22.7% / +19 | 62.5% / 4.5% / 10.2% / +1 |
| **5-day** | **37.6% / 13.2% / +16** | **75.9% / 1.5% / 6% / +1** |

**Robustness checks**
- **Out-of-sample:** on 07-29/30/31 (never tuned on; no inflight logging, so the mechanism
  was tested with measured latency), actual 27.9% → 65.4%, overshoot tail 9.6% → 0%.
- **Not overfit:** the entire top-10 of the grid search sits at 74–76% with near-identical
  constants — a plateau, not a spike. Leave-one-day-out is stable.
- **Worst days win most:** 08-03 and 08-05 (the two heavy-overshoot days) go from 31% and
  22.7% over-tail to 3.4% and 4.5%.

## 6. Honest caveats

1. **Re-timing second-order effect** — the transform holds each fire's drift fixed while
   changing its lead. Firing earlier shifts when a fire commits and the inflight it meets,
   which changes its true latency and drift. The policy self-corrects (live velocity + live
   inflight both shrink), so the risk is bounded, but the exact live in-band % may land
   below the simulated 75.9%. This is the only caveat a log replay cannot fully close.
2. **Latency constants (5, 0.25)** are fixed from 5 days. The steepest-latency day (08-03)
   shows the largest residual overshoot (worst +46). A rolling floor/slope estimate would
   harden this later.
3. **Undershoot** rises from ~0% to 6% (worst −17). Far milder than the POS_MAX_LEAD=50
   rejection (36% breach), but non-zero — watch it against the undershoot contract, and it
   is tunable down with a <1 multiplier at a few points of in-band.

## 7. Implementation

Localized to the position fire decision in `src/services/monitorService.js`. The existing
code already computes drift as `rate × horizon` (`estimatedDrift`) — the two problems are
that (a) the horizon is the bot-execution horizon, not SAN commit latency, and (b) the
result is clamped to `POS_MAX_LEAD = 10`, throwing the correction away
(`monitorService.js:2255`).

Changes:

1. **Keep a short observed-queue history** for the 8s velocity. In the poll loop, push
   `{ t: Date.now(), q: waitingCount }` into a small ring buffer; expose
   `observedVelocity(nowMs)` = slope over the last 8s, floored at 0 and capped at 2.5/s.
2. **Read inflight at decision time** from `botService._pendingFireVis.size` (add a tiny
   `currentInflight()` getter to avoid poking the map directly).
3. **Predictive lead**, gated by a flag:

```js
// near the existing rawLead / lead computation (monitorService.js:2247)
const PREDICTIVE_LEAD = (process.env.MONITOR_PREDICTIVE_LEAD ?? '0') === '1';
const PRED_LAT_FLOOR  = parseFloat(process.env.MONITOR_PRED_LAT_FLOOR ?? '5');    // s
const PRED_LAT_SLOPE  = parseFloat(process.env.MONITOR_PRED_LAT_SLOPE ?? '0.25'); // s per inflight
const PRED_LEAD_CAP   = parseInt(process.env.MONITOR_PRED_LEAD_CAP  ?? '40', 10);
const PRED_VEL_CAP    = parseFloat(process.env.MONITOR_PRED_VEL_CAP ?? '2.5');    // /s

let lead;
if (PREDICTIVE_LEAD && isWithinBurstWindow()) {
  const v          = Math.min(observedVelocity(Date.now()), PRED_VEL_CAP);
  const inflight   = currentInflight();
  const predLatS   = PRED_LAT_FLOOR + PRED_LAT_SLOPE * inflight;
  lead = Math.min(Math.round(v * predLatS), PRED_LEAD_CAP);
} else {
  lead = Math.min(rawLead, maxLeadPositions, growthLeadCap); // unchanged
}
```

Everything downstream (`projectedLanding = effectiveQueue + lead`, the fire decision, the
past-max rail) is unchanged — we only change how `lead` is sized inside the burst window.

**As implemented**, the lead computation in `evaluatePositionScheduler` gains a
burst-window-only branch that overrides the flat `min(rawLead, POS_MAX_LEAD, growthLeadCap)`
with `D = clamp(observedVelocity × (floor + slope·inflight), 0, cap)`. `observedVelocity`
comes from a time-bounded queue buffer (`recordVelocityObservation` / `observedVelocity`)
independent of poll cadence; `inflight` from `botService.currentInflight()`.

**Env knobs (all overridable live, no code change):**

| var | default | meaning |
|---|---|---|
| `MONITOR_PREDICTIVE_LEAD` | `0` | master on/off (kill switch) |
| `MONITOR_PRED_LAT_FLOOR` | `5` | exogenous latency floor, s |
| `MONITOR_PRED_LAT_SLOPE` | `0.25` | latency added per inflight fire, s |
| `MONITOR_PRED_LEAD_CAP` | `40` | max lead (positions) |
| `MONITOR_PRED_VEL_CAP` | `2.5` | max velocity used, /s |
| `MONITOR_PRED_VEL_WINDOW` | `8` | trailing velocity window, s |

**Kill switch:** `MONITOR_PREDICTIVE_LEAD=0` reverts to today's behavior instantly, no
deploy.

## 8. Rollout

1. Land the code with `MONITOR_PREDICTIVE_LEAD=0` (dormant — identical to today).
2. Flip to `1` before a storm. Watch the first morning's oracle-shadow report and the
   ±10 / >+40 / <−10 split.
3. If a storm looks wrong, set it back to `0` — instant revert.
4. Once confirmed, fold in a rolling latency floor/slope estimate to replace the fixed
   `5 + 0.25·inflight` and remove caveat #2.

---

# ADDENDUM — 2026-08-10: the estimator is retired inside the avalanche band

**Status:** SHIPPED. `MONITOR_PRED_LEAD_MAX_TARGET=199` added; inside the band the
lead is the undershoot budget itself, not `v × latency`.
Evidence: 710 fire+landing pairs from `logs/2026-08-01..09`.

## What the 9 days actually say

The overshoot is not a "deep target" problem. It is a **dwell-time** problem, and the
band is sharply bounded on *both* sides:

| target band | seconds SAN's queue spends per position | err p50 | within ±10 |
|---|---|---|---|
| 40–69   | 0.47 s | +2  | 75% |
| 70–99   | **0.17 s** | +23 | 14% |
| 100–149 | **0.20 s** | +41 | 2%  |
| 150–199 | 0.22 s | +41 | 10% |
| 200–299 | 5.09 s | +6  | 55% |
| 300+    | —      | −1  | 100% |

SAN sweeps positions ~60→200 in about **25 seconds** (1 s peaks of +25…+42
positions), then plateaus. 77% of our fires target that band. Our commit latency is
5–20 s. You cannot place an add at a chosen position inside a window the queue crosses
in 0.2 s per position while your actuation delay is 5–20 s — so **±10 in this band is
not reachable by any control law**, and every "better estimator" was always going to
fail. The perfect-lead floor (queue movement over the *unpredictable* part of latency
alone) is |resid| p50 19–24, p90 34–47.

## Why the v×latency estimator specifically fails

1. **It cannot lead a step input.** `observedVelocity` is a trailing slope. Logged
   v was `0.12/s` five minutes before the 08-09 avalanche; the queue then moved 25–39
   positions in single seconds. Realised leads came out at a median of 16 in the 70-84
   band where +36 was needed.
2. **The answer is capped anyway.** The drift to cover is +36/+56/+70/+64/+55 (median,
   bands 70-84 … 150-199) while the −30 guarantee hard-caps any lead at 30. The
   estimator's output is therefore *always* short; computing it more cleverly cannot
   change that. Spending less than the full 30 is strictly worse, never safer — the
   floor is what makes it safe.

## Where the drift comes from (`err + lead = organic drift + our own adds cutting ahead`)

| band | total drift p50 | organic | **ours** | ours % |
|---|---|---|---|---|
| 70–84 | +36 | +22 | +27 | 55% |
| 85–99 | +56 | +28 | +50 | 64% |
| 100–119 | +70 | +28 | +43 | 61% |
| 150–199 | +55 | +31 | +16 | 34% |

Fleet-wide in 70–199: **60% of the drift the lead must cover is our own fleet
committing ahead of itself.** Commit latency splits `our 1.0 s / SAN 8.5 s` (p50); the
extra latency under load is **96% SAN-side** (SAN 4.4 s at inflight ≤5 → 9.6 s at ≥20 →
13.9 s at ≥45). We inflate SAN's own commit path by hammering it. More RAM, more
browsers and faster clicking cannot touch this — our side is already 1 s.

## The change

Once the queue is genuinely moving (`observedVelocity ≥ MONITOR_PRED_LEAD_MOVE_RATE`,
default 0.5/s) and `70 ≤ target ≤ 199`, fire at the earliest point the −30 guarantee
permits. No coefficient to drift out of calibration. Static queue → old estimate, so a
morning whose storm never arrives does not land the fleet at −29.

Replay over 08-01..09 (conservative — it credits only the earlier click, not the lower
inflight that follows):

| | ±10 | ±15 | >+20 | >+40 | p50 | p90 | worst under |
|---|---|---|---|---|---|---|---|
| today | 35% | 42% | 51% | 21% | +21 | +49 | −11 |
| **after** | **51%** | **59%** | **35%** | **13%** | **+9** | **+45** | **−26** |

Zero landings below −30 (structural: the click needs displayed ≥ target−30, SAN appends
at the tail, displayed ≤ true tail ⇒ landing ≥ target−29).

## The honest limit — read this before tuning anything again

−30 is close to the *optimal* budget, not a compromise: sweeping it over the 70–199
band gives ±15 of 55/64/**70**/65/57% at −10/−20/**−30**/−40/−50. Past −30 the
undershoot costs more than the overshoot saves.

But the budget is **short by 6–13 positions** of what bands 85–199 need to centre
(required shift +36/+43/+39/+41 vs a 30 cap). So after this change:

* **70–84 is solved** — ±10 18%→62%, >+40 14%→0%.
* **85–199 improves but cannot be finished by any lead**, because the required lead
  exceeds the guarantee. Its remaining error is `SAN commit latency × queue velocity`.

The only lever left for 85–199 is **SAN's commit latency**, and the only part of it we
control is our own concurrency (inflight 45+ ⇒ SAN latency 13.9 s and a p90 of 49 s;
37% of the residual >+20 fires had latency ≥20 s). Note the trade is real and was
measured: pacing hard enough to hold latency down means missing the 25 s avalanche
window entirely, which is worse. Do not re-litigate lead tuning — that avenue is closed.

---

# ADDENDUM — 2026-08-11: inflight-scaled band lead + −45 floor

**Status:** SHIPPED (behind `MONITOR_PREDICTIVE_LEAD`, kill-switchable). Supersedes the
"flat budget when moving" branch. Evidence: fresh 10-day live analysis, `logs/2026-08-01
..08-10`, **563 fire+landing pairs** in 70-199 (harness in scratchpad: `analyze.js`,
`drift.js`, `inflight_lead.js`, `final.js`; reparsed from `📍 Bot queued` / `PosTracking
landed` / `⏱ commit latency`).

## What the live data forced a rethink

With the cap-30 predictive lead LIVE, the band still lands **±10 9%, median +31, >+40
36%, zero undershoot (worst −9)**. Two additive causes:

1. **Lead undersized.** Drift (landed − queueAtFire) is p50 +44, p90 +74, max +186 — far
   past a flat 30.
2. **The flat 30 was never even achieved.** Effective lead (target − queueAtFire) ran
   **p50 14, p90 26** — the avalanche (25–39 pos/s) leaps past the fire threshold between
   1 s polls, silently eating ~15 positions. This is why live median (+31) is ~+18 worse
   than the flat-30 transform (+13). Faster burst polling / anticipatory fire is the
   direct lever for cause 2 — untested, deferred (SAN-load risk).

The earlier addendum said "spend the full 30, computing it more cleverly cannot help
because the cap binds." The live data says the cap does **not** bind on storm days
(undershoot is 0), so the cap was leaving overshoot on the table, and there IS a
click-time signal worth computing.

## The signal: inflight, not velocity

- corr(velocity, drift) = **−0.08** — a trailing slope cannot see the step onset.
- corr(inflight, drift) = **0.59** — our own clicked-but-uncommitted fires LEAD the drift
  (they are what pushes the queue past the target). Monotonic by bucket: drift p50
  5/28/39/47/71 across inflight 0-5 / 6-15 / 16-30 / 31-45 / 46+.
- OLS: `drift ≈ 19 + 0.86·inflight`, residual std 15 (raw drift std 18.6).

## The change

Moving-queue band lead becomes `D = clamp(round(19 + 0.86·inflight), 20, 45)`, and the
hard floor moves 30 → 45 so those leads can actually fire. Env knobs:
`MONITOR_PRED_DRIFT_INTERCEPT` (19), `MONITOR_PRED_DRIFT_SLOPE` (0.86),
`MONITOR_PRED_LEAD_FLOOR` (20), `MONITOR_PRED_LEAD_CAP` (45),
`MONITOR_PRED_LEAD_HARD_FLOOR` (45).

**Band-confined floor.** BOTH the aggressive lead and the −45 floor apply ONLY to
targets in `[MIN_TARGET, MAX_TARGET]` = 70-199. The lead was already gated on both
bounds; the hard floor is now banded too — targets ≥200 keep the original −30 guarantee
(`MONITOR_PRED_LEAD_OUTER_FLOOR`, default 30). Those deep targets crawl (~5 s/position),
already land ±10, and get the flat lead, so loosening their floor would only expose them
to a probe/onset undershoot for no benefit. Verified in `monitor.test.js`
("BAND-CONFINED FLOOR"): a target-100 fire holds to `−45`, a target-250 fire to `−30`.

## Simulation (transform error = drift − D, all 10 days, band 70-199)

| policy | ±10 | ±15 | >+20 | >+40 | med | p90 | <−30 | worst |
|---|---|---|---|---|---|---|---|---|
| actual (live logs) | 9% | 17% | 73% | 36% | +31 | 60 | 0% | −9 |
| flat-30 (prior intent) | 42% | 52% | 39% | 12% | +13 | 42 | 0% | −26 |
| **inflight→45 (this)** | 37% | 56% | 23% | **1%** | **+3** | 28 | **0%** | −23 |
| oracle (D=drift, cap 60) | 88% | 94% | 2% | 0% | 0 | 12 | 0% | 0 |

Per-day: >+40 falls to 0% on 8 of 10 days; the two extreme days (08-08, 08-10) stay hot
(+31 / +24 median). The −30… now −45 guarantee **holds structurally on every day**
(worst −23) because D reaches 45 only at high inflight, whose min drift is 22-27 — those
fires never stall; low-inflight fires get D≈20-30 and a shallow floor.

## Honest limits (read before touching this again)

1. **Not a path to ±10.** Oracle (perfect click-time drift) tops out at 88%; inflight
   explains only ~35% of drift variance, so the transform tops at ~37-43%. The rest is the
   queue-velocity noise during commit that is unknowable at click time — the same physics
   ceiling as the addenda above.
2. **Live will run ~+15 worse than the transform** (cause 2, unfixed by this change). The
   real, defensible win is the **>+40 tail (36%→~1%) and the centred median**, not ±10.
   Correspondingly, live undershoot runs ~15 shallower than the transform, so the −45
   guarantee is even safer live than the −23 shown.
3. **The guarantee loosened −30 → −44** (product decision, approved 2026-08-11). Realized
   worst over 10 days is −23. A never-seen day where a high-inflight batch forms and then
   SAN stalls could in principle reach −44; kill switch is `MONITOR_PREDICTIVE_LEAD=0`.
