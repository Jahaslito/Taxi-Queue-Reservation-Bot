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
