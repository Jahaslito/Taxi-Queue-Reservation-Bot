# Position-Based Firing — How Drivers Get Into the Morning Queue

This document explains, end to end, everything the code does for **position-based
firing** (a.k.a. position scheduling): how the monitor watches SAN's V Holding
queue every morning and fires each driver's bot at exactly the right moment so
they land as close as possible to their chosen queue position.

It reflects the code as it stands today, **including the uncommitted working-tree
changes** to `src/services/monitorService.js` and `docker-compose.yml` and the new
test `tests/services/stormWatchCadence.test.js`. Where a behavior is new (the
2026-07-27 storm-watch package), it is called out explicitly.

Everything here lives in **`src/services/monitorService.js`** unless noted.
`botService.js` owns the actual browser automation (arming, clicking, firing);
this document treats it as a black box with a small, named interface.

---

## 1. The problem, in one paragraph

Every morning SAN's "V Holding" queue fills up as drivers request to join. A
driver wants to land at a **specific position** (say, target 120) — early enough
to get good dispatches, not so early they waste the slot. The catch: the queue is
a **storm**. It can sit dead-flat for an hour, then jump **50+ positions in a
single 5-second server tick** as competitors batch-add. SAN's displayed count is
also **stale** — it lags the true tail by a median of +6 (up to +56). So we can't
just "fire when the number hits the target"; by the time the number says fire,
it's already wrong. The whole system is built to fire **before** the chunk, on a
**proven** estimate of the true queue, with landings bounded by construction.

### The ±10 accuracy contract

The design target is: **every driver lands within ±10 positions of their target.**

- **Undershoot half (never land more than 10 *below* target):** enforced by
  clamping the fire *lead* to `POS_MAX_LEAD` (10). Because V Holding only grows
  during the morning (shrinkage pauses firing), the worst case is "the burst
  stalls the instant we fire" → the driver lands at `queue_at_fire + 1 =
  target − lead + 1`. Clamping lead at 10 makes landings below `target − 9`
  **impossible by construction**, no matter how wrong the rate estimate is.
- **Overshoot half (never land more than ~10 *above* target):** enforced by
  **cutting fire latency** — pre-armed browser sessions (a fire is a ~1 s click,
  not a ~3.5 s Chromium launch) plus the 1 s burst poll cadence — and by the
  storm-onset early-fire rule that fires *ahead* of a detected chunk.

Everything below is machinery in service of that contract.

### One golden rule: positions, not time

The most important design principle: **bursts are position-locked, not
time-locked.** Storm onset lands at queue **60–85 every morning** (median ~71)
while its *clock time* swings 42+ minutes day to day (and, more recently, spans
04:00 to 06:44). So almost every real decision is made in **queue positions**,
and time-based estimates (`secondsUntilFire`) are treated as soft guesses that a
chunk storm can invalidate in one tick.

---

## 2. The morning lifecycle at a glance

```
        clock (PT)     what happens
        ──────────     ────────────────────────────────────────────────────────
00:00   midnight       Daily reset. Counters cleared. Overnight leftovers tagged
                       "carryover" and given a durable marker (survives restart).

~02:00  SAN purge      SAN empties V Holding overnight. Carryover drivers drop out;
                       their carryover flag clears; they become fireable at target.

03:00   pos window     Position window ARMS (armPositionWindowForToday): every
        opens          driver reset to "watching", ready for today's schedule.
                       Any leftover SAN didn't purge is dropped + armed to fire fresh.

03:00   storm-watch    Storm-watch window opens (3:00–8:00 AM PT). The monitor is
        opens          now in "storm readiness" mode: prearm + zero-buffer drift math.
                       Poll cadence is ACTIVITY-GATED (see §11): idle 5 s while calm.

~04-06  the storm      Queue ramps. Onset detector arms. Cadence tightens to 1 s.
                       Fleet pre-arms. Each driver fires as projection reaches target
                       (or earlier, on the onset rule). Bots run, drivers land.

~06-08  plateau        Storm dies. All targets fired. Queue parked high (~270) but
                       calm. Cadence RELEASES back to the normal adaptive rate — the
                       morning's work is done, nothing left to catch.

08:00   window closes  Storm-watch window ends. Back to normal all-day operation.
```

The rest of this document walks each phase in detail.

---

## 3. Windows and hours

Three separate time windows govern different things. All are Pacific Time and all
are env-configurable.

| Window | Default | Constant(s) | Governs |
|---|---|---|---|
| **Operating hours** | 5 AM – 11 PM | `OP_START_HOUR`, `OP_END_HOUR` | Auto-requeue (unrelated to position firing) |
| **Position hours** | 3 AM – 11 PM | `POS_START_HOUR`, `POS_END_HOUR` | When the position scheduler runs at all (`isWithinPositionHours`) |
| **Storm-watch window** | 3 AM – 8 AM | `BURST_START_HOUR`, `BURST_END_HOUR` | Storm readiness: prearm eligibility, zero-buffer burst drift math, and the fast poll cadence (`isWithinBurstWindow`) |

> **⚠️ Uncommitted change — storm-watch window widened.** The window used to be a
> fixed **4:00–5:30 AM**, chosen when storms reliably hit in that 90-minute span.
> July onsets crept as early as **~04:00**, and Sunday peaks now land **~05:40**
> (some as late as **06:44** — well past the old 5:30 cutoff, which skipped them
> entirely at the slow cadence). It is now **3:00–8:00 AM, all days**. This is only
> affordable because the 1 s poll *inside* the window is now activity-gated (§11) —
> otherwise a 5-hour window would be 5 hours of hammering SAN at 1 s.

`currentHourPT()` is the single timezone read; both `isWithinPositionHours()` and
`isWithinBurstWindow()` are simple `hour >= start && hour < end` checks against it.

---

## 4. Driver state — the fields that matter

Each watched driver has an in-memory `state` object (`watches` is a `Map` of
`driverId → state`). The fields that drive position firing:

- **`scheduledPosition`** — the driver's base target position.
- **`dayPositions`** — optional JSON map `{ "0".."6" → position }` for
  day-of-week overrides (Sunday=0). When present, today's entry **wins**; if the
  map exists but has no entry for today, the driver has **no target today** and is
  skipped. Resolution lives in two mirrored places — `resolveTargetPosition()`
  (the fleet pre-pass) and inside `evaluatePositionScheduler()` (the per-driver
  decision) — kept identical so they never disagree.
- **`maxAcceptablePosition`** — tolerance ceiling. Driver-configured, else
  `target + 40`. If the queue is already past this, firing is pointless (the
  driver would land far above max) → recorded as `missed_impossible`.
- **`positionFiredToday`** — set once the driver fires (or is terminally skipped);
  blocks re-firing for the rest of the day.
- **`hasBeenSeen`** — driver has been observed in V Holding today (already in
  queue) → skip.
- **`inQueueFromCarryover`** — driver was a leftover in V Holding at midnight;
  hold firing until SAN drops them (see §6).
- **`wasCarryoverToday`** — durable, day-scoped version of the above that stays
  true all day (survives a drop-then-reappear).
- **`state`** — coarse machine: `watching`, `in_queue`, `dispatched`,
  `at_terminal`, `requeuing` (bot in flight).
- **`borrowedAsProbe`** — driver is currently lent to the tail probe (checked out;
  don't fire/prearm/time them).

---

## 5. Daily reset (midnight PT)

On the first poll after the PT date rolls over (`poll()`, top):

1. Per-driver counters reset: `positionFiredToday=false`, `requeueCountToday=0`,
   `landedPositionToday=null`, decision/tracking pointers cleared, etc.
2. **Carryover tagging.** Any driver still `hasBeenSeen` (in V Holding at
   midnight) is tagged `inQueueFromCarryover=true` **and** `wasCarryoverToday=true`.
   Why: SAN empties V Holding overnight (queue=0 by ~02:00). If we fired now, the
   driver would land on SAN's "Already in queue" WAIT screen and record
   *yesterday's* position as today's actual. So we **wait for the purge**.
3. **Durable carryover marker.** For every leftover, a `carryover_marker` `Log`
   row is written. This is what lets `addWatch()` rebuild carryover protection
   after a **restart** between midnight and the morning fire — the one window
   where neither the reset nor the 3 AM re-arm runs again.
4. **Onset state reset** — yesterday's storm tracking must not leak forward.
5. Optional active remove of leftovers (`CARRYOVER_REMOVE_ENABLED`, off by
   default) — best-effort, routed through the job queue, can never strand anyone.

---

## 6. Position-window arming (3 AM PT)

Once per day, the first poll inside position hours calls
**`armPositionWindowForToday()`**:

- For every driver, decide if they're **observably queued** (`in_queue` /
  `dispatched` / `at_terminal` / `hasBeenSeen`). If so, treat them as a leftover
  (`inQueueFromCarryover = wasCarryoverToday = true`) so firing waits for the
  purge; otherwise reset to `watching`.
- Clear `hasBeenSeen`, `positionFiredToday`, terminal flags, early-join flags,
  etc. — a clean slate for today's schedule.
- Never yank state from under an in-flight bot (`requeuing` is left alone).

Then **`dropAndArmCarryoverLeftovers()`** proactively pulls any leftover SAN did
*not* purge overnight (still in V Holding at window-open) and arms it to fire
fresh at target — rather than waiting hours for SAN's drop, by which point the
tail has grown past max. Only **confirmed** removals arm; a failed/unconfirmed
drop leaves carryover protection intact.

The same logic is exposed per-driver as **`allowRefireToday()`** for the admin
"🎯 Arm" button and the allow-refire endpoint — behaviorally identical to the
3 AM auto-arm.

---

## 7. The poll tick — overview

`poll()` runs every `currentPollDelayMs` (adaptive, see §11). Each tick:

1. **Fetch + parse** SAN's queue page → `{ dispatched, waiting, notAuthorized }`.
   `waitingCount = waiting.size` is the live queue depth.
2. **Estimate growth rate** (`effectiveGrowthRate`, §8).
3. Record a `QueueSnapshot` (pure data collection; the scheduler doesn't read it
   at runtime).
4. Refresh **bias correction** periodically (every 20 ticks).
5. Advance the **onset detector** once for the tick (§9).
6. Build a shared **`decisionCtx`** (all the numbers below).
7. Compute the **fleet-wide prearm signal** (`earliestTargetToday` → `stormBuilding`).
8. **Loop over every watched driver**, call `evaluatePositionScheduler(state, ctx)`,
   and apply the returned decision's side effects (fire / wait / skip / prearm /
   borrow).
9. **Launch this tick's fires**, most-overdue target first.
10. **Reconcile pre-armed sessions** with botService (declarative converge).
11. Optionally sync the tail probe / borrow probe.
12. **Set the next poll cadence** (§11).

---

## 8. Growth-rate estimation

The lead/drift math needs "how fast is the queue growing, in drivers/second."
`effectiveGrowthRate` is the **max of four signals** (so no single noisy source
under-estimates during a burst):

- **`lastPollRate`** — drivers added since the previous poll ÷ elapsed seconds.
- **`shortWindowRate`** — slope over the last `SHORT_WINDOW_POLLS` (3) observations
  — more stable than a single delta, faster than an EMA.
- **`smoothedGrowthRate`** — EMA (α=0.7) of the per-second rate.
- **`EMERGENCY_SURGE_RATE`** (0.5/s) — a floor that protects the cold-start case
  (first poll, no history) and calm periods.

A big single-tick drop (`rawDelta ≤ −10`) sets **`queueShrinkageDetected`** — SAN
just promoted a batch waiting→dispatched (common at the 5 AM dispatch open). This
**pauses firing** for a poll cycle (see §10, the dispatch-purge guard), because
firing across a purge would land drivers 50–80 positions *below* target.

---

## 9. Drift, horizon, bias, and the lead

The **lead** is how many positions early we fire, to account for the queue growing
between the fire decision and when SAN actually stamps the driver's slot.

```
horizonSeconds = pollAgeSeconds + (effectiveBotExecMs / 1000) + safetyBufferS
estimatedDrift = max(POS_DRIFT_FLOOR, ceil(driftRate × horizonSeconds))
rawLead        = estimatedDrift + biasCorrection
lead           = min(rawLead, POS_MAX_LEAD, growthLeadCap)
```

- **`horizonSeconds`** — how far into the future we must predict:
  - `pollAgeSeconds` — the data is already this stale when we read it.
  - `effectiveBotExecMs` — the rolling **median** of recent bot run times
    (cold-start default `POS_BOT_EXEC_MS` = 7 s), inflated by **burst batching**:
    if `N` bots are already in flight, this bot waits behind them —
    `effectiveBotExecMs = botExecMs × ceil((inflight+1) / concurrency)`.
  - `commitLatencyS` — **⚠️ SAN commit latency (2026-07-28).** `effectiveBotExecMs`
    only measures our *own* run time (decision → click). It is blind to SAN's own
    commit latency — the wall-clock gap between our click and SAN stamping the
    slot. On the 07-27 storm that gap stalled to **22–42 s** as a ~34/s onset
    drained through the fire pool, and every pending fire landed **150+** past
    target (overshoot ↔ commit latency r=0.869). We now **measure** it per fire
    (`recordCommitLatency`: fire-decision timestamp → genuine landing stamp) and
    expose a fresh rolling **median** (`commitLatencyEstimateMs`). When
    **`MONITOR_COMMIT_LATENCY_LEAD`** (default **off**) is on, that median is
    added to the horizon. It **never** relaxes the ±10 contract: the lead it
    feeds is still clamped by `POS_MAX_LEAD` and `growthLeadCap`, so a full storm
    is already pinned (no-op) and only a moderate morning's under-predicted
    horizon tightens. The measurement + logging run regardless of the flag — the
    flag gates only whether the number influences a decision.
  - `safetyBufferS` — 10 s cushion **outside** the storm window; **0 inside** it.
    The buffer helps on slow-creep mornings but *triples* drift during a burst
    (`horizon 19 s × 2.23/s = 42` → fires 25–40 too early); dropping it inside the
    window is required to hit ±10.
- **`driftRate`** — inside the window, the rate used *for drift math only* is
  capped at `BURST_DRIFT_RATE_CAP` (3.0/s). A single-tick spike can read 15–75/s;
  uncapped, `drift = 75 × 15 = 1125` would instantly mark every driver
  `missed_impossible`. The **uncapped** rate still drives fire *timing*
  (`secondsUntilFire`) — we only tame the drift estimate, not the trigger.
- **`biasCorrection`** — median of recent `(actual − target)` landing errors from
  `position_tracking` (outliers |err|>30 filtered). If we keep landing too far
  back, bias is positive → prediction bumped up → bot fires earlier.
- **`growthLeadCap`** (`GROWTH_LEAD_ENABLED`, default ON) — an *additional* cap of
  `max(2, ceil(2 + rate×3))`. Lead is spent undershoot; never spend more than the
  measured growth can repay during the commit. On a calm pre-storm morning
  (≤0.3/s) this pins lead to 2–3 (killing the −11…−13 pre-storm class); at storm
  rates (≥2.7/s) the cap is ≥10, i.e. a no-op — it never delays a real burst fire.
- **`POS_MAX_LEAD`** (10) — the hard ceiling; the undershoot half of the ±10
  contract. This is the single most important clamp in the system.

---

## 10. `evaluatePositionScheduler()` — the decision tree

This is the pure heart of the system. Given a driver's `state` and the tick's
`ctx`, it returns exactly one decision. It is a **pure function** (locked-out
predicate is injected) so it's fully unit-testable. The decisions, in order:

**Early skips / holds (checked first, top to bottom):**

1. `state.isActive === false` → **`skip_no_target`** (inactive drivers aren't scheduled).
2. No target today (no `scheduledPosition`, or `dayPositions` has no entry for
   today, or malformed JSON) → **`skip_no_target`**.
3. `positionFiredToday` → **`skip_already_fired`** (target still feeds the
   undershoot-rescue detector).
4. Credentials locked out → **`skip_locked_out`** (don't burn a slot on a
   guaranteed failure; *not* marked fired, so a mid-day password fix re-enables them).
5. `state === 'requeuing'` → **`skip_bot_inflight`** (bot already running).
6. `inQueueFromCarryover` → **`wait` / `awaiting_overnight_purge`** (leftover
   still in V Holding; wait for SAN's drop — `secondsUntilFire = Infinity`).
7. `hasBeenSeen` → **`skip_already_seen`** (already in queue today).

**Past-max rails (the train has left the station):**

8. `waitingCount > maxAcceptable` → **`missed_impossible` / `queue_already_past_max`**.
9. `queueShrinkageDetected` → **`wait` / `queue_shrinking`** (dispatch purge in
   progress; re-poll in 30 s).

**Projection & fire decision:**

10. Compute `lead` (§9). Compute the **effective queue** — normally
    `waitingCount`, but the **fleet-landing probe** (§12) can raise it to a fresh,
    proven true-tail lower bound so we catch the band instead of firing late on
    the stale display.
11. `displayedProjection = waitingCount + lead` (drives the past-max rail);
    `projectedLanding = effectiveQueue + lead` (drives the fire decision).
12. `displayedProjection > maxAcceptable` → **`missed_impossible` /
    `projection_exceeds_max`** ("below max now, but we'd land past max").
13. **Fire** if either:
    - `projectedLanding ≥ target` (**`projection_reached_target`**), **or**
    - the **onset early-fire** rule fires it (**`onset_early_fire`**, §9/§below).
14. Otherwise → **`wait` / `projected_below_target`**, carrying `secondsUntilFire`
    (`positionsUntilFire / rate`, or Infinity with no growth) which drives adaptive
    polling and prearm.

### Storm-onset early fire (`MONITOR_ONSET_FIRE`, default OFF)

A **position-only** rule (no time anywhere) that fires drivers *before* a detected
chunk. `gap = target − effectiveQueue`. Because `effectiveQueue` is a **proven
lower bound** of the true tail, firing while `gap ≤ onsetAllow` bounds the
worst-case landing at `target − onsetAllow` even if the storm dies on the click.

- **Onset detector** (`onsetStep`, render-aware): SAN's display changes every ~5 s
  while we poll at 1 s, so a "step" only exists when the value *changes*. It arms
  when the storm **signature** appears inside the zone (queue in
  `[ONSET_ZONE_MIN, ONSET_ZONE_MAX]` **and** rate ≥ `ONSET_RATE` or a render step
  ≥ `ONSET_STEP`), stays armed while evidence keeps arriving, and disarms after
  `ONSET_QUIET_MS` of quiet.
- **Dynamic calm-guard cap** (`onsetCapNow`): the allowance in force =
  `min(ONSET_CAP, max(POS_MAX_LEAD, 2 × biggest recent render step))`. A lone +5
  flurry on a calm morning unlocks only ~10 early (≈ normal lead, no extra
  undershoot); a real +10…+42 chunk unlocks the full cap within one render.
- **Backlog boost** (`onsetBacklogBoost`): may deepen the cap up to `ONSET_CAP_MAX`
  *only* while a deep SAN processing backlog is **proven live** (display slope ×
  age of the oldest in-flight fire not yet visible in V Holding). The deep cap was
  **retired 2026-07-21** (`ONSET_CAP_MAX` back to 25) because the overshoot it
  fought is now attacked at its source by botService's fast page release; the math
  still runs but is ceilinged at 25.
- **Target-horizon guard**: the deep allowance is prior-safe only for targets the
  storm is certain to run past. `target ≤ ONSET_SAFE_HORIZON` (170) gets the full
  cap; `≤ ONSET_MID_HORIZON` (200) gets at most `ONSET_MID_CAP` (15); **above 200
  the onset rule is off** — the plain lead rule fires them on proven queue, which
  the post-storm drain serves at −6…−9 instead of the cap's −12…−19.
- **Modes**: `0` off (default) · `shadow` log-only (logs where it *would* fire, to
  size the opportunity before going live) · `1` live.

---

## 11. Poll cadence and prearm — the 2026-07-27 storm-watch package ⚠️ (uncommitted)

This is the largest of the uncommitted changes. The goal: **cut SAN load** during
the now-much-wider storm-watch window **without ever missing or delaying a fire.**

Before, the rule was crude: inside the burst window, lock the poll to **1 s** and
pre-arm **every** waiting driver — for the *entire* window. With the window
widened to 3:00–8:00, that would mean ~5 hours of 1 s polling and ~60–75 SAN
sessions held warm across the dead-calm pre-storm hour and the post-storm plateau,
for no gain. The new design makes both the **cadence** and the **prearm**
**activity-gated**.

Three tiny **pure helper functions** were extracted from `poll()` so this logic is
unit-tested in isolation (`tests/services/stormWatchCadence.test.js`):

### `computeStormReadiness()` → drives prearm

The fleet is "building" toward the day's **earliest still-unfired target** when the
queue is either:

- **actively MOVING** — onset armed, **or** `growthRate ≥ MOVEMENT_RATE_PER_S`
  (0.3/s), **or**
- that earliest target is **projected within `PREARM_LEAD_SECS` (20 min)** of being
  reached: `secsToEarliestTarget = (earliestTarget − waitingCount) / growthRate`.

`secsToEarliestTarget` is `Infinity` when the queue is flat (rate ≤ 0) or every
target is already fired — so **neither the pre-storm calm nor the post-storm
plateau reports building.** Movement catches a fast onset; the earliest-target
projection catches a **gradual pre-ramp creep** even while the rate is still below
the movement threshold (the real 07-26 04:47 case: rate 0.15, queue 36, earliest
50 → 93 s away → arm now). 20 min is a generous lead — arming the fleet takes
seconds — so **no driver ever fires cold.**

The day's `earliestTargetToday` is computed in a small pre-pass over `watches`
(skipping inactive, borrowed, and already-fired drivers) using
`resolveTargetPosition()`.

### `isQueueActive()` → drives the 1 s cadence hold

The queue is "active" (hold 1 s) when **onset armed**, **or** `growthRate ≥
MOVEMENT_RATE_PER_S`, **or** a fire is **imminent** (`minSecondsUntilFire ≤
IMMINENT_FIRE_SECS`, 45 s — covers the last driver in a dying storm). Crucially,
"active" means the queue is **MOVING**, *not merely sitting high* — an
absolute-level test would keep us at 1 s through the whole post-storm plateau
(queue parked at ~270 with nothing left to fire). Growth rate and an imminent fire
are the true ramp signals, and both fall silent on the plateau.

### `computePollDelayMs()` → the cadence tiers

```
if (!smart)                          → inWatchWindow ? 1 s : adaptive   (FAIL-SAFE)
if (!(inWatchWindow && firePending)) → adaptive (30–90 s)               (outside window OR morning done)
                                     → queueActive ? 1 s : min(idle 5 s, adaptive)
```

- **Outside the window** → normal adaptive rate (`expectedNextPollMs`, 30–90 s).
- **Inside the window, a fire still pending, queue active** → **1 s burst** (what
  keeps a chunk catchable — at 5 s the queue can jump 50 positions in one tick,
  skipping a 40-wide target window whole; the Jun 05 relaxation to 30 s here cost
  10 drivers).
- **Inside the window, fire pending, queue calm** → **5 s idle floor**
  (`BURST_IDLE_POLL_MS`) — still far tighter than the old out-of-window
  relaxation. A nearer scheduled fire can pull it faster than the floor
  (`min(idleMs, adaptiveMs)`).
- **Inside the window but the morning's fires are ALL done** (`positionFirePending`
  is false — every driver fired / missed / no-target / carryover-awaiting-purge)
  → **leave the fast cadence entirely** and fall back to the normal adaptive rate,
  even though the clock is still inside the window. The plateau can run hours;
  there's nothing left to catch. It **re-tightens on its own** the moment a fire
  becomes pending again (a requeue, a carryover leaving, a target edit).

**`positionFirePending`** is set true for any driver this tick that is `fire`,
`skip_bot_inflight`, or `wait` for a reason *other than* `awaiting_overnight_purge`
(carryover-purge waiters fire on the purge, not on queue growth, so they don't
keep the morning "live").

### Prearm eligibility (per-driver, in the loop)

A `wait` decision (not carryover) arms a pre-armed session if **any** of:

- **`prearmReady`** — the fleet-wide `stormBuilding` signal above (replaces the old
  "whole burst window" rule), **or**
- this driver's own **projected fire is near** (`secondsUntilFire ≤
  PREARM_AHEAD_SECS`, 240 s), **or**
- the queue has reached the **position-locked storm zone** (`waitingCount ≥
  PREARM_QUEUE_POS`, 45) — a backstop for a chunk storm that invalidates the
  rate-based estimate in one tick.

The wanted set is handed to `botService.syncFireSessions()` **declaratively** every
tick — botService converges (arms missing, refreshes stale, disarms dropped), with
all throttling (dedup, failure cooldowns, `ARMED_MAX` cap) inside it, so calling it
every 1 s is safe. Credentials are fetched/decrypted lazily, only if an arm
actually happens.

### 🛟 The master fail-safe: `MONITOR_SMART_CADENCE`

One env flag reverts **every** 2026-07-27 change to the conservative pre-change
behavior: lock to **1 s for the whole window** and pre-arm **every** waiting driver
across it (never activity-gated, never released early). It trades SAN load for
guaranteed readiness. Flip it to `0`/`false` — **no code deploy, just an env change
+ restart** — the moment the smart logic is ever suspected of missing or delaying a
fire. Default **ON** (smart behavior). When off, `prearmReady = inBurstWindow` and
`computePollDelayMs` returns `1 s` for the whole window.

---

## 12. Fleet-landing true-tail probe (`MONITOR_FLEET_PROBE`, default OFF)

SAN's displayed queue lags the real tail (median +6, up to +56). But every time
one of *our* drivers lands, SAN tells us their exact position = the true tail at
that instant. Because the morning queue is **append-only**, that landing is a valid
**lower bound** on the tail forever after. So:

```
effectiveQueue = max(displayedQueue, freshestLanding − 1)     (capped at +FLEET_PROBE_MAX_LEAD)
```

Firing on `effectiveQueue` catches the band instead of firing late on the stale
display — cutting **overshoot** without ever firing early in true-position terms
(undershoot stays ≥ −9, since `effectiveQueue ≤ true tail`). It only ever **adds** a
fire, never a skip (the past-max rail still uses the *displayed* projection).
`recordFleetLanding()` keeps the **highest** landing within the fresh window
(`FLEET_PROBE_FRESH_MS`, 8 s), not the latest — stragglers from slow armed clicks
arrive below the true tail and must not lower the estimate. A fresh, higher
observation nudges the poll immediately rather than waiting up to 1 s.

The **tail probe** (`tailProbeService`, `MONITOR_TAIL_PROBE`) and **borrowed
probe** (`MONITOR_BORROW_PROBE`) are optional feeders that generate those true-tail
samples during a storm — either a dedicated sacrificial account, or by lending the
probe the highest-target watched drivers whose fire is provably far enough away
that we can always hand them back (rate-aware retire buffer). Both are off by
default and out of scope here; see the constant comments and `tailProbeService.js`.

---

## 13. Firing a driver

When a `fire` decision is returned, the driver is added to `fireBatch`. After the
loop, the batch is **sorted most-overdue target first** and each is launched via
`triggerPositionSchedule(driverId, state, effectivePosition, fireOpts)`
(fire-and-forget). `triggerPositionSchedule` claims the pre-armed session in its
first synchronous slice (before any await), so every claim lands ahead of this
tick's `syncFireSessions` reconciliation — the disarm-race guarantee holds. The
`fireOpts` carry `growthRate`, `estimatedDrift`, `predictedLanding`, and
`maxAcceptablePosition` for the tracking row.

---

## 14. Environment variables reference

The knobs that govern position firing (all read at module load). Defaults shown;
docker-compose wires them through with the same defaults.

### Windows & cadence

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_POS_START_HOUR` / `..._END_HOUR` | 3 / 23 | Position scheduler active hours (PT) |
| `MONITOR_BURST_START_HOUR` / `..._END_HOUR` | 3 / 8 | **⚠️ Storm-watch window (widened from 4:00–5:30)** |
| `MONITOR_BURST_POLL_MS` | 1000 | Fast (burst) poll cadence |
| `MONITOR_BURST_IDLE_POLL_MS` | 5000 | **⚠️ Idle floor inside the window when calm** |
| `MONITOR_MOVEMENT_RATE` | 0.3 | **⚠️ Rate (pos/s) at/above which the queue counts as "moving"** |
| `MONITOR_IMMINENT_FIRE_SECS` | 45 | **⚠️ A fire this close holds the 1 s cadence** |
| `MONITOR_SMART_CADENCE` | true | **⚠️ MASTER FAIL-SAFE — set 0 to revert to always-burst + arm-all** |

### Lead / drift / bias

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_POS_MAX_LEAD` | 10 | Hard lead ceiling — the ±10 undershoot contract |
| `MONITOR_COMMIT_LATENCY_LEAD` | false | **⚠️ Fold measured SAN commit latency into the horizon (instrumentation always on; flag gates only the horizon use)** |
| `MONITOR_POS_DRIFT_FLOOR` | 5 | Floor for the per-tick drift estimate |
| `MONITOR_POS_LEAD_BUFFER` | 5 | Minimum lead buffer (near-zero-growth days) |
| `MONITOR_GROWTH_LEAD` | 1 | Growth-scaled lead cap (`0` disables) |
| `MONITOR_POS_BOT_EXEC_MS` | 7000 | Cold-start bot exec estimate |
| `MONITOR_EMERGENCY_SURGE_RATE` | 0.5 | Growth-rate floor |
| `MONITOR_SAFETY_BUFFER_MS` | 10000 | Horizon cushion (dropped to 0 inside the window) |
| `MONITOR_BURST_DRIFT_RATE_CAP` | 3.0 | Rate cap for drift math only (not fire timing) |

### Prearm

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_PREARM_ENABLED` | true | Master prearm switch |
| `MONITOR_PREARM_AHEAD_SECS` | 240 | Per-driver "fire is near" arm trigger |
| `MONITOR_PREARM_LEAD_SECS` | 1200 | **⚠️ Fleet-wide dynamic prearm lead (20 min)** |
| `MONITOR_PREARM_QUEUE_POS` | 45 | Position-locked arm-everyone backstop |

### Onset early fire

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_ONSET_FIRE` | 0 | `0` off · `shadow` log-only · `1` live |
| `MONITOR_ONSET_ZONE_MIN` / `_MAX` | 40 / 90 | Arming zone (queue positions) |
| `MONITOR_ONSET_RATE` / `_STEP` | 1.2 / 5 | Signature: rate or render-step |
| `MONITOR_ONSET_CAP` / `_CAP_MAX` | 25 / 25 | Early-fire allowance (deep cap retired) |
| `MONITOR_ONSET_SAFE_HORIZON` / `_MID_HORIZON` / `_MID_CAP` | 170 / 200 / 15 | Target-horizon guard |
| `MONITOR_ONSET_QUIET_MS` | 25000 | Disarm after this much quiet |

### Probes (optional, off by default)

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_FLEET_PROBE` | 0 | Use fleet landings as a true-tail lower bound |
| `MONITOR_TAIL_PROBE` | 0 | Dedicated sacrificial tail-sampling account |
| `MONITOR_BORROW_PROBE` | 0 | Lend far-target drivers to the probe |

---

## 15. Summary of the uncommitted working-tree changes

Everything marked ⚠️ above is part of the **2026-07-27 storm-watch package**, not
yet committed. In one place:

**`src/services/monitorService.js`:**
- **Storm-watch window widened** 4:00–5:30 → **3:00–8:00 AM**, all days
  (`isWithinBurstWindow` rewritten to `BURST_START_HOUR`/`BURST_END_HOUR`).
- **Activity-gated cadence**: 1 s only while the queue is *moving*; 5 s idle floor
  through the calm; full release to the normal adaptive rate once the morning's
  fires are all done — even inside the window.
- **Dynamic fleet prearm**: arm when the fleet is *building* (moving, or earliest
  target within a 20-min lead) instead of blanket-arming the whole window.
- **Three extracted pure helpers** — `computeStormReadiness`, `isQueueActive`,
  `computePollDelayMs` — plus `resolveTargetPosition`, all exported for tests.
- **`positionFirePending`** tracking, and the **`MONITOR_SMART_CADENCE` master
  fail-safe** to revert all of it via env.

**`docker-compose.yml`:** wires the new env vars (`MONITOR_BURST_START_HOUR`,
`MONITOR_BURST_END_HOUR`, `MONITOR_BURST_POLL_MS`, `MONITOR_BURST_IDLE_POLL_MS`,
`MONITOR_SMART_CADENCE`, `MONITOR_PREARM_LEAD_SECS`) with matching defaults and
inline rationale.

**`tests/services/stormWatchCadence.test.js`:** new unit suite pinning the three
cadence helpers plus `resolveTargetPosition`, including the full
calm→creep→storm→done→requeue→plateau lifecycle and the `SMART_CADENCE=off`
fail-safe.

**Net effect:** the same guaranteed readiness and ±10 landing accuracy as before,
over a **much wider** storm window, at a **small fraction** of the SAN polling and
warm-session load — with a single-flag escape hatch if the smarter logic is ever
suspected.
