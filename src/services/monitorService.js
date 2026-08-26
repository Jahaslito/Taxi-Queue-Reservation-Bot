'use strict';

const fs    = require('fs');
const path  = require('path');
const { fetch: ufetch, ProxyAgent } = require('undici');

// ─── Queue Monitor Service ────────────────────────────────────────────────────
//
// Polls V Holding (10-17), T1 (10-8), and T2 (10-9) queue pages.
// V Holding is fetched every tick regardless of driver count (O(1) cost).
// T1/T2 are fetched in parallel — only when at least one driver is in the
// at_terminal state (zero cost otherwise).
// State is kept in-memory; DB is written only when the bot actually runs.
//
// Two watch sources:
//   AUTO   — every is_active driver, loaded on start, refreshed every 5 min.
//   MANUAL — added via the Monitor page "Watch Vehicle" button.
//
// State machine per driver:
//
//   watching ──(seen in V Holding)──► in_queue ──(dispatched row)──► dispatched
//      ▲                                                                   │
//      │                                                     (left V Holding)
//      │                                                                   ▼
//      │                                                          at_terminal
//      │                                                    (polling T1 + T2)
//      │                                                                   │
//      │                                                (gone from T1 & T2)│
//      │                                                                   ▼
//      └──────────────────────────────────────────── requeuing ◄───────────
//                                                        │
//                                             (bot done) │
//                                                        ▼
//                                                   watching
//
// Scalability notes:
//   • One V Holding fetch per tick regardless of driver count (O(1) network cost).
//   • T1/T2 fetched in parallel only when at least one driver is at_terminal.
//   • O(n) in-memory state-machine pass with cheap Set lookups.
//   • Bot jobs are concurrency-capped (MONITOR_CONCURRENCY, default 3).
//   • EventEmitter supports up to 500 SSE clients.

const { EventEmitter }    = require('events');
const Driver              = require('../models/Driver');
const Log                 = require('../models/Log');
const PositionTracking    = require('../models/PositionTracking');
const TerminalMetric      = require('../models/TerminalMetric');
const QueueSnapshot       = require('../models/QueueSnapshot');
const proxyHealth         = require('./proxyHealthService');
const credentialLockout   = require('./credentialLockoutService');
const dispatchNotify      = require('./dispatchNotificationService');
const { decrypt }         = require('./cryptoService');

// ─── Constants (overridable via env for testing / tuning) ────────────────────
// POLL_INTERVAL_MS is the maximum (idle) cadence. Adaptive polling tightens to
// 10 s or 5 s when any position-scheduled driver is close to firing — see
// computeNextPollMs() below. Trade-off: bandwidth vs miss-rate near surge.
const POLL_INTERVAL_MS  = parseInt(process.env.MONITOR_POLL_MS     ?? String(90_000), 10);
const POLL_NEAR_FIRE_MS = parseInt(process.env.MONITOR_POLL_NEAR_FIRE_MS ?? '10000', 10); // <60s away
const POLL_AT_FIRE_MS   = parseInt(process.env.MONITOR_POLL_AT_FIRE_MS   ??  '5000', 10); // <20s away
const FETCH_TIMEOUT     = parseInt(process.env.MONITOR_TIMEOUT     ?? String(15_000), 10);
const BOT_CONCURRENCY   = parseInt(process.env.MONITOR_CONCURRENCY ?? '3',                10);
const AUTO_REFRESH_MS   = parseInt(process.env.MONITOR_REFRESH_MS  ?? String(5 * 60_000), 10);
const RETRY_COUNT       = parseInt(process.env.MONITOR_RETRY_COUNT ?? '3',                10);
// Delays between successive retry attempts (ms). Index 0 = after 1st failure.
const RETRY_DELAYS      = [5_000, 15_000, 30_000];
// How long to wait after detecting a driver is gone before firing the auto-requeue bot.
// Gives the SAN server time to finish processing the dispatch before accepting a re-queue.
// Does NOT apply to manual Run button or scheduled triggers.
const AUTO_REQUEUE_DELAY_MS = parseInt(process.env.MONITOR_REQUEUE_DELAY_MS ?? String(60_000), 10);

// ─── Overnight carryover handling ─────────────────────────────────────────────
// A driver still in V Holding at the midnight rollover is a leftover from
// yesterday. SAN drains the overnight queue by dispatching everyone out the
// front — so a leftover that reaches the front gets paper-dispatched (~1–2 AM),
// no-shows (the driver isn't physically there), and SAN benches the account as
// "not authorized" past the morning rush. That driver then can't take its real
// target position (the #0187 / #4377 failures). Fix: at the reset, proactively
// remove leftovers from V Holding so they never reach the front to be dispatched
// — they start the morning free to fire fresh at their scheduled target.
// DISABLED BY DEFAULT (2026-06-15): the active midnight remove proved ineffective
// — leftovers reappeared in V Holding within seconds and still drained to the
// front (e.g. #0034: "removed" 00:00, back at pos 18 by 00:00:44, dispatched at
// pos 8 by 00:09) — while its "success" logs + flag-clearing stripped carryover
// protection and stranded the whole fleet as "already in queue". Protection now
// comes purely from the carryover machinery (durable marker + debounced clear),
// which no longer depends on this remove. Opt back in with the env flag to
// experiment, but it can no longer strand anyone: removeCarryoverLeftover() is
// pure best-effort and never touches the protection flags.
const CARRYOVER_REMOVE_ENABLED = (process.env.MONITOR_CARRYOVER_REMOVE_ENABLED ?? 'false') === 'true';
// Debounce for the carryover-cleared signal: require the driver to be absent
// from V Holding for this many consecutive polls before dropping the carryover
// flag. SAN's V Holding list is unstable around the midnight refresh — a single
// missed poll wrongly flips a still-queued leftover to "fresh today" (the
// 00:01:44 mislabel that started #0187's chain). 3 polls confirms a real exit.
const CARRYOVER_CLEAR_POLLS    = parseInt(process.env.MONITOR_CARRYOVER_CLEAR_POLLS ?? '3', 10);

// ─── Auto-remove from SAN's red "not authorized" zone ─────────────────────────
// When SAN benches a vehicle it re-lists its V Holding row as class="notauthorized"
// (rendered red). The driver is visible in the queue but blocked — they can't hold
// a position or be dispatched, and the only fix is to leave the queue and rejoin.
// Historically the driver had to do this by hand ("Remove From Queue" in SAN).
// With this ON, the monitor fires that same remove automatically the moment it
// sees a driver in the red zone, then VERIFIES on the next poll that they are no
// longer not_authorized.
//
// SAFETY: this reuses removeFromQueue (a REMOVE-type 'redzone_auto_remove' trigger)
// and — like removeCarryoverLeftover — NEVER mutates carryover/hasBeenSeen flags,
// so it cannot re-create the 2026-06-15 fleet-strand (that was caused by clearing
// protection on a self-reported remove "success"; hasBeenSeen is now add-only).
// CHURN GUARD: most red-zone events are the ~00:00 carryover wave, and SAN re-adds
// a removed cab within seconds — so a per-cab cooldown + daily cap keep the retry
// from turning into a hot loop that hammers SAN. Kill switch: set the env to false.
const REDZONE_AUTO_REMOVE_ENABLED = (process.env.MONITOR_REDZONE_AUTO_REMOVE_ENABLED ?? 'true') === 'true';
// Minimum gap between remove attempts for the same cab (SAN's re-list is near-instant).
const REDZONE_REMOVE_COOLDOWN_MS  = parseInt(process.env.MONITOR_REDZONE_REMOVE_COOLDOWN_MS ?? String(90_000), 10);
// Hard cap on remove attempts per cab per Pacific day — bounds the midnight churn.
const REDZONE_REMOVE_MAX_PER_DAY  = parseInt(process.env.MONITOR_REDZONE_REMOVE_MAX_PER_DAY ?? '6', 10);

// ─── Forced drop of stuck leftovers at the position-window open (3 AM) ─────────
// SAN's overnight purge clears most leftovers by ~02:00, but NOT all of them.
// Log analysis (2026-06-26…30) shows 1–6 of our drivers per day stay in V Holding
// past 3 AM — SAN finally drops them as late as 05:22 / 09:55 / even 19:42, by
// which point the morning tail has grown past their max acceptable position, so
// the first real fire decision is "too late, skipping" and they miss target for
// the day (e.g. #1965 target 118, dropped 19:42 at tail 394; #0920 target 130,
// dropped 09:55 at tail 456). The passive carryover machinery correctly avoids
// firing onto the stale spot, but it can only wait — it can't rescue them.
//
// Now that removeFromQueue VERIFIES removal against SAN's V Holding list (no more
// false "success"), we proactively pull these leftovers when the position window
// opens — while the tail is still small (~30–40) — and arm them to fire fresh at
// target. Safe-by-construction: a driver is only re-armed when removeFromQueue
// CONFIRMS the vehicle is gone; on anything less (not confirmed / dispatched /
// error) every carryover flag is left untouched, so the existing passive
// machinery covers the driver exactly as before — a failed drop can't strand it.
// Kill switch: set MONITOR_CARRYOVER_DROP_ENABLED=false to disable without deploy.
const CARRYOVER_DROP_ENABLED   = (process.env.MONITOR_CARRYOVER_DROP_ENABLED ?? 'true') === 'true';

// ─── Operating hours (Pacific Time) ──────────────────────────────────────────
// Auto-requeue fires between REQUEUE_START and REQUEUE_END (8 AM–11 PM PT).
// Position schedule fires between POS_START and POS_END (4 AM–11 PM PT).
// Manual runs via the Run button are never gated by either window.
const OP_START_HOUR  = parseInt(process.env.MONITOR_START_HOUR     ?? '5',  10); //  5 AM PT
const OP_END_HOUR    = parseInt(process.env.MONITOR_END_HOUR       ?? '23', 10); // 11 PM PT
const POS_START_HOUR   = parseInt(process.env.MONITOR_POS_START_HOUR   ?? '3',  10); //  3 AM PT
const POS_END_HOUR     = parseInt(process.env.MONITOR_POS_END_HOUR     ?? '23', 10); // 11 PM PT
// Minimum lead buffer (positions). Small safety cushion for near-zero growth days.
// The dynamic drift calculation takes over whenever growth exceeds ~10 drivers/tick.
const POS_LEAD_BUFFER  = parseInt(process.env.MONITOR_POS_LEAD_BUFFER  ?? '5', 10);
// Floor for the per-tick drift estimate. The old value of 20 was too aggressive
// — it caused systematic over-firing on quiet/flat-queue mornings (drivers
// landing 10-20+ positions BELOW target). 5 keeps a small cushion without
// fabricating growth that isn't there.
const POS_DRIFT_FLOOR  = parseInt(process.env.MONITOR_POS_DRIFT_FLOOR  ?? '5',  10);
// Hard ceiling on the total lead (drift + bias) the fire decision may apply —
// THE ±10 accuracy contract, undershoot half. The lead is exactly the
// worst-case undershoot: V Holding only grows during the morning window
// (shrinkage pauses firing via the dispatch-purge guard), so if the burst
// stalls the instant we fire, the driver lands at queue_at_fire + 1 =
// target − lead + 1. Clamping lead at 10 makes landings below target − 9
// impossible BY CONSTRUCTION, no matter how wrong the rate estimate is —
// the May 30–Jun 04 incidents (−36…−68, drift 37–98 extrapolated from burst
// spikes that stalled) cannot recur. The overshoot half of the contract is
// handled by cutting fire latency: pre-armed sessions (botService) + the 1 s
// burst poll. Raising this above 10 trades undershoot risk for burst
// overshoot protection; don't, unless the ±10 contract itself changes.
const POS_MAX_LEAD     = parseInt(process.env.MONITOR_POS_MAX_LEAD     ?? '10', 10);
// ─── Predictive velocity×latency lead (MONITOR_PREDICTIVE_LEAD) ───────────────
// Storm overshoot = queue drift during SAN's commit latency, which the flat
// POS_MAX_LEAD=10 clamp cannot cover (landings averaged +33 above queue-at-fire
// while lead was pinned at 10). Inside the burst window, size the lead to the
// drift we can measure at click time: D = clamp(velocity × predictedLatency, 0,
// cap). velocity = trailing-window slope of observed V Holding depth (capped so
// a one-tick spike can't inflate it); predictedLatency = floor + slope × inflight
// (inflight = our own clicked-but-uncommitted fires — botService.currentInflight).
// 8-day replay (see OVERSHOOT-PREDICTIVE-LEAD.md): ±10 37.6%→75.9%, >+40
// 13.2%→1.5%, median +16→+1. Default OFF — flip the flag to 0 for instant revert.
const PREDICTIVE_LEAD    = (process.env.MONITOR_PREDICTIVE_LEAD ?? '0') === '1';
const PRED_LAT_FLOOR_S   = parseFloat(process.env.MONITOR_PRED_LAT_FLOOR ?? '5');    // s, exogenous storm floor
// 2026-08-07 recalibration: on the first 25-browser/100-armed storm the 0.25
// slope under-predicted the self-inflicted commit latency (native inflight ran
// to 58, latency to 20s), so the lead covered <½ the drift. 7-storm replay
// (08-01..07) puts the drift↔inflight slope near 0.7 for target≥70.
const PRED_LAT_SLOPE_S   = parseFloat(process.env.MONITOR_PRED_LAT_SLOPE ?? '0.7');  // s per inflight
// 2026-08-11 recalibration — INFLIGHT-SCALED band lead. A fresh 10-day live
// analysis (logs 08-01..08-10, 563 fire+landing pairs in 70-199) found the flat
// `lead = PRED_LEAD_CAP` branch below leaves TWO problems on the table:
//   1. The lead is undersized. Drift (landed − queueAtFire) is p50 +44, p90 +74,
//      max +186 — far past a flat 30. Landings sat median +31 above target.
//   2. The flat lead can't distinguish the fires that actually drift from the
//      ones that don't. The only signal available AT CLICK TIME that tracks
//      drift is `currentInflight` (corr 0.59; velocity is a trailing slope and
//      is useless here — corr −0.08). OLS over the band: drift ≈ 19 + 0.86·inflight
//      (monotonic by bucket: drift p50 5/28/39/47/71 as inflight rises through
//      0-5/6-15/16-30/31-45/46+). So SIZE the moving-queue lead to inflight:
//        D = clamp(INTERCEPT + SLOPE·inflight, FLOOR, CAP)
//      Sim (transform error = drift − D, all 10 days): >+40 12%→1%, median +13→+3,
//      p90 42→28, and the undershoot guarantee HOLDS structurally per-day (worst
//      −23) because the deep leads (D→45) only ever apply to high-inflight fires,
//      whose min drift is 22-27 — they never stall. Low-inflight fires get D≈20-30,
//      so their floor stays shallow. See OVERSHOOT-PREDICTIVE-LEAD.md §2026-08-11.
const PRED_DRIFT_INTERCEPT = parseFloat(process.env.MONITOR_PRED_DRIFT_INTERCEPT ?? '19');   // positions
const PRED_DRIFT_SLOPE     = parseFloat(process.env.MONITOR_PRED_DRIFT_SLOPE     ?? '0.86');  // positions per inflight
const PRED_LEAD_FLOOR      = parseInt(process.env.MONITOR_PRED_LEAD_FLOOR   ?? '20', 10);     // min moving-queue lead
const PRED_LEAD_CAP      = parseInt(process.env.MONITOR_PRED_LEAD_CAP    ?? '45', 10);
const PRED_VEL_CAP       = parseFloat(process.env.MONITOR_PRED_VEL_CAP   ?? '2.5');  // /s
const PRED_VEL_WINDOW_S  = parseFloat(process.env.MONITOR_PRED_VEL_WINDOW ?? '8');   // s trailing slope window
// Only the deep targets suffer the storm-commit overshoot; low targets fire early
// at low inflight and already land ~±10, so the aggressive lead is gated to
// target ≥ this. Below it, the flat/bias lead path is unchanged.
const PRED_LEAD_MIN_TARGET = parseInt(process.env.MONITOR_PRED_LEAD_MIN_TARGET ?? '70', 10);
// …and gated to target ≤ this. The overshoot is NOT a "deep target" problem, it
// is an AVALANCHE-BAND problem: SAN sweeps positions ~60→200 in about 25 s
// (dwell 0.17–0.22 s per position), while positions below ~55 and above ~200
// crawl (0.5 s and 5.1 s per position). Measured over 08-01..09: err p50 is +21
// / +36 / +43 / +39 / +41 across bands 70-84 / 85-99 / 100-119 / 120-149 /
// 150-199, but only +6 at 200-299 and −1 above 300. Those slow bands already
// land inside ±10 (55% and 100%); giving them the aggressive lead would push
// them to a −24 median. Before this bound existed the gate was open-ended, so
// any lead increase silently taxed the one band that was already correct.
const PRED_LEAD_MAX_TARGET = parseInt(process.env.MONITOR_PRED_LEAD_MAX_TARGET ?? '199', 10);
// Minimum observed velocity (positions/s) before we spend the FULL undershoot
// budget. The queue must actually be moving: on a dead-calm morning the storm
// may never arrive, and firing target−30 into a stalled queue lands at −29 for
// no reason. Any real onset is ≫ this (sustained 4–9/s, 1 s peaks to 42/s).
const PRED_LEAD_MOVE_RATE  = parseFloat(process.env.MONITOR_PRED_LEAD_MOVE_RATE ?? '0.5');
// HARD UNDERSHOOT FLOOR (positions). For gated targets we NEVER fire when the
// DISPLAYED queue is more than this far below target. waitingCount ≤ true tail
// (SAN's display only lags) and SAN appends at the tail, so worst-case landing
// is ≥ waitingCount+1 ≥ target − FLOOR + 1 ⇒ undershoot can never be worse than
// −(FLOOR−1). This bound holds independently of the predictive lead, the fleet
// probe over-reading, or the storm stalling on the click — it is the guarantee,
// not a tuned value.
// 2026-08-11: raised 30 → 45 to match PRED_LEAD_CAP, so the inflight-scaled lead
// can actually fire at target−45 during a confirmed avalanche (the hard floor
// only ever HOLDS a fire; at 30 it silently re-capped any lead >30 back to 30).
// The STATED worst-case undershoot loosens to −44; the REALIZED worst over 10
// days is −23, because a lead reaches 45 only at high inflight, which only
// happens mid-storm where the queue never stalls. This is a product decision
// (approved 2026-08-11): −44 guarantee in exchange for >+40 tail 36%→~1%.
// IMPORTANT: this −45 floor applies ONLY inside the avalanche band
// [MIN_TARGET, MAX_TARGET] (70-199) — the only band that gets the aggressive
// inflight-scaled lead. Targets ≥200 crawl (≈5 s/position), already land ±10,
// and would only be exposed to a deep undershoot by the probe/onset paths, so
// they keep the original −30 guarantee via PRED_LEAD_OUTER_FLOOR below.
const PRED_LEAD_HARD_FLOOR = parseInt(process.env.MONITOR_PRED_LEAD_HARD_FLOOR ?? '45', 10);
// Undershoot floor for gated targets OUTSIDE the avalanche band (target > MAX_TARGET).
// Unchanged from the pre-2026-08-11 guarantee (−30) — the band-only loosening
// must not silently weaken the deep-target contract.
const PRED_LEAD_OUTER_FLOOR = parseInt(process.env.MONITOR_PRED_LEAD_OUTER_FLOOR ?? '30', 10);
// Tick-pipe lead (MONITOR_TICK_PIPE_LEAD, default OFF, '1' enables): the pass
// (see runTickPipePass) re-evaluates the tick's still-waiting drivers with the
// same-tick fire batch counted into inflight, lowest target first — built to
// close the one-snapshot-inflight blind spot (08-16: all 42 leap-tick fires
// read inflight 26 while the k-th actually joined a pipe of 26+k, landing a
// uniform +26…+48). FALSIFIED LIVE 08-21/08-22, the two worst days recorded
// (±10 = 5% and 2%): on a queue leap the pass is a positive-feedback loop —
// each recruited fire grows the pipe, which grows the lead, which unlocks
// deeper targets in the SAME tick, until the roster is exhausted (104 and 92
// fires in one second). The recruitment also doubles everyone's commit latency
// (inflight ~100 vs ~40), so even the fires it does NOT recruit land +35-58.
// The fixpoint IS the full-roster batch — retuning the cap cannot fix it.
// Default OFF restores the 08-15 regime (74% ±10 live, leap days ~11-32%).
const TICK_PIPE_LEAD = String(process.env.MONITOR_TICK_PIPE_LEAD ?? '0') === '1';
// Pre-onset ladder (MONITOR_LADDER: '1' live [default], 'shadow' log-only,
// '0' kills): place drivers BEFORE the avalanche instead of firing into it.
// Why: the storm window physically cannot absorb the roster — SAN commits
// accurately at ~0.4 adds/s while the display sweeps the 70-199 band in ~25s,
// so any estimator that waits for the leap fires 70-100 thresholds in one tick
// (08-21: 104 fires/1s, ±10 = 5%; 08-22: 92 fires/1s, ±10 = 2%). The calm
// mornings that DID hit 74% (08-15) worked because the pre-dawn crawl walked
// the queue through our targets one by one — an emergent ladder: each of our
// own commits raises the queue by 1, unlocking the next target. On 08-21/22
// the leap arrived at queue 28-29, BELOW the first target (~40), so the chain
// never ignited. This rule ignites and sustains it deliberately: in the calm
// pre-onset window, fire any driver whose target is within LADDER_GAP of the
// effective queue. Undershoot bound BY CONSTRUCTION: landing ≥ effectiveQueue
// + 1 ≥ target − LADDER_GAP + 1 = target − 10 at the default gap 11 — i.e.
// every ladder fire lands inside the ±10 band on the undershoot side, and calm
// commits (~5s, inflight ≤ tick cap) bound the overshoot side at ~−4. Ladder
// sim on the real 08-22 roster (113 targets, queue start 29): 85-96 drivers
// placed pre-storm, queue raised to 122-144 by our own adds with only 10-20
// positions of external trickle; the storm then faces a residue of ~20 instead
// of the whole roster. Serialized LADDER_TICK_MAX/tick so the chain climbs at
// SAN's accurate pace and stays below every storm trigger (onset step ≥5,
// onset rate ≥1.2/s, pred-lead move ≥0.5/s). Gates: burst window AND wall
// clock ≥ LADDER_AFTER (PT), no active onset, observed velocity < MAX_VEL
// (a real storm outruns the ladder instantly and the storm machinery owns the
// tick), and the hard undershoot floor still applies on the DISPLAYED queue,
// so a probe over-read during a display freeze holds the fire.
const LADDER_MODE      = String(process.env.MONITOR_LADDER ?? '1');
const LADDER_LIVE      = LADDER_MODE === '1';
const LADDER_SHADOW    = LADDER_MODE === 'shadow';
const LADDER_GAP       = parseInt(process.env.MONITOR_LADDER_GAP ?? '11', 10);
const LADDER_TICK_MAX  = parseInt(process.env.MONITOR_LADDER_TICK_MAX ?? '2', 10);
const LADDER_MAX_VEL   = parseFloat(process.env.MONITOR_LADDER_MAX_VEL ?? '0.5');
// "HH:MM" PT — the ladder never fires before this wall-clock time. Default
// 03:30 gives ~30-90 min of calm runway before observed storm starts
// (04:01-05:09 range) while staying inside the 3-8 burst window.
const LADDER_AFTER_PT  = String(process.env.MONITOR_LADDER_AFTER ?? '03:30');
const LADDER_AFTER_MIN = (([h, m]) =>
  (parseInt(h, 10) % 24) * 60 + (parseInt(m, 10) || 0))(LADDER_AFTER_PT.split(':'));
// Ladder SEED tier (08-23): the gap-11 chain assumes a pre-dawn crawl reaches
// within 11 of the first target. 08-23 falsified that assumption — the queue
// sat at 0-9 until 05:15 (first target ~50), the chain had nothing to ignite
// from, and the whole roster was still waiting when the leap hit. The seed
// tier breaks that stall by spending the operator's declared undershoot
// budget: when the chain has no in-band rung to fire and nothing in flight,
// fire the SINGLE lowest-target waiting driver whose gap ≤ LADDER_SEED_GAP —
// one per tick, so seeds land ascending and each raises the queue toward the
// next. Landing bound: ≥ effectiveQueue+1 ≥ target − SEED_GAP + 1. On a
// crawl morning (queue ~25, first target 40) seeds land −14…−2 and tighten as
// the chain takes over; on an empty morning (08-23: queue 5, targets 50+)
// they land deep (−40…−64) — bounded, ZERO overshoot, vs the wall's +45…+85.
// SEED_GAP defaults to the band undershoot floor (MONITOR_PRED_LEAD_HARD_FLOOR)
// so the operator's single "undershoot budget" knob governs both; 0 disables.
// SCOPED LIKE THE FLOOR ITSELF: the full budget applies ONLY to targets inside
// the avalanche band [PRED_LEAD_MIN_TARGET, PRED_LEAD_MAX_TARGET] (70-199).
// Shallow (<70) and deep (≥200) targets seed at most LADDER_SEED_SHALLOW (29,
// the onset-cap precedent — worst landing −28, inside the original −30
// contract), so a target-50 driver can never be seeded to position ~2.
const LADDER_SEED_GAP = (() => {
  const v = parseInt(process.env.MONITOR_LADDER_SEED_GAP ?? '', 10);
  return Number.isFinite(v) ? v : PRED_LEAD_HARD_FLOOR;
})();
const LADDER_SEED_SHALLOW = parseInt(process.env.MONITOR_LADDER_SEED_SHALLOW ?? '29', 10);
// Seed GROWTH gate (2026-08-24, per operator: "if it is calm the undershoot
// should be minimal — the early shoot must be informed by how the list is
// growing, not fire just because a target is in range"). The seed tier spends
// deep undershoot ONLY when the list is genuinely building toward a storm, and
// scales the depth it may spend with how much it has grown:
//   • SEED_MIN_RISE (8): net positions the queue must have climbed over the
//     window before ANY seed fires. Dead calm nets ~0 ⇒ gate shut ⇒ those
//     drivers wait and land accurate (the gap-11 chain still runs, −4…−10).
//   • SEED_RISE_WINDOW_S (150): the trailing window sustainedRise() measures
//     over — long enough that jitter can't fake a sustained climb.
//   • SEED_GAP_PER_RISE (3): allowed seed depth = rise × this, clamped to the
//     scoped budget. A gentle ramp (rise 8) unlocks only ~24 positions of
//     undershoot; a strong build (rise ≥ 22) unlocks the full band budget.
// So calm ⇒ zero seed undershoot; the depth grows only as fast as the list does.
const LADDER_SEED_MIN_RISE    = parseInt(process.env.MONITOR_LADDER_SEED_MIN_RISE ?? '8', 10);
const SEED_RISE_WINDOW_S      = parseInt(process.env.MONITOR_LADDER_SEED_WINDOW ?? '150', 10);
const LADDER_SEED_GAP_PER_RISE = parseFloat(process.env.MONITOR_LADDER_SEED_GAP_PER_RISE ?? '3');
const LADDER_SEED_AFTER_PT  = String(process.env.MONITOR_LADDER_SEED_AFTER ?? '03:45');
const LADDER_SEED_AFTER_MIN = (([h, m]) =>
  (parseInt(h, 10) % 24) * 60 + (parseInt(m, 10) || 0))(LADDER_SEED_AFTER_PT.split(':'));
// ─── PROACTIVE seed ("be the onset" — MONITOR_LADDER_PROACTIVE) ───────────────
// 2026-08-24 replay verdict: the growth-gated seed places almost nobody on a
// leap-from-quiet storm (08-22/23), because the growth signal only appears
// ~60s before the leap. The two operator asks — "informed by growth" and "be
// the onset ourselves" — are in direct conflict: the growth gate can only JOIN
// a visible build, never START one. This mode resolves it with a STRONGER
// PRIOR than instantaneous growth: at this airport the avalanche hits inside a
// known daily window (~04:00-05:30, see storm-dow-profile), so during that
// window a storm is a near-certainty and pre-placing is justified WITHOUT a
// growth signal. To keep "minimal undershoot unless justified", the allowed
// depth RAMPS with the wall clock: shallow (≈ gap 11, near-accurate) at
// _AFTER, widening linearly to the full scoped budget by _PEAK (the historical
// storm time) — so a band driver is only placed deep as the leap becomes
// imminent by the CLOCK. Still scoped (band vs shallow/deep), still serialized
// (1/tick, inflight-gated), still yields the instant onset arms or velocity
// spikes. Modes: '0' off (default), 'shadow' log-only (deploy-and-observe),
// '1' live. The growth-gated seed keeps running underneath in every mode.
const LADDER_PROACTIVE_MODE   = String(process.env.MONITOR_LADDER_PROACTIVE ?? '0');
const LADDER_PROACTIVE_LIVE   = LADDER_PROACTIVE_MODE === '1';
const LADDER_PROACTIVE_SHADOW = LADDER_PROACTIVE_MODE === 'shadow';
const LADDER_PROACTIVE_AFTER_PT = String(process.env.MONITOR_LADDER_PROACTIVE_AFTER ?? '04:00');
const LADDER_PROACTIVE_PEAK_PT  = String(process.env.MONITOR_LADDER_PROACTIVE_PEAK  ?? '05:10');
const toMin = (s) => (([h, m]) => (parseInt(h, 10) % 24) * 60 + (parseInt(m, 10) || 0))(String(s).split(':'));
const LADDER_PROACTIVE_AFTER_MIN = toMin(LADDER_PROACTIVE_AFTER_PT);
const LADDER_PROACTIVE_PEAK_MIN  = toMin(LADDER_PROACTIVE_PEAK_PT);
// Proactive CHAIN extension (2026-08-24, "cannot afford another miss"): the
// ramp above deepens the seed slowly (full budget only by _PEAK 05:10) and the
// seed pass places one-per-commit (~0.2/s). Both were sized to keep undershoot
// minimal — but on a near-empty-queue-then-leap morning (08-24: queue ≤20 until
// a 16 s leap at 04:16) that is exactly why the 70-200 band was still unplaced
// when the storm hit (20 misses). Under the operator's revised priority
// (a MISS is worse than bounded undershoot — a placed driver still earns) these
// two knobs let the proactive seed run as a FRONT-LOADED chain:
//   • _FULL=1  → allowed seed depth is the full scoped budget the moment the
//     window opens (no clock ramp), so the band is seed-eligible from _AFTER.
//   • SEED_MAX_INFLIGHT (N) → up to N of our own seeds may be in flight at once
//     (default 1 = the original one-per-commit serialization). N≈4-6 keeps
//     concurrency at SAN's accurate low-commit knee (measured 08-24: ≤6 in
//     flight → ~5 s commit, ±2 landing; the 87-in-8s onset burst → 8-13 s, ±40)
//     while giving ~1/s — enough to seat a ~120 roster in ~2 min of calm.
// Thorough 08-24 replay (extract.py/funnel.py, model validated to ±2 on the
// day's real spread seeds): 0 misses, 0 overshoot, ~30-45% ±10, median ≈ −13,
// worst ≈ −55 on the top targets (chain from a near-empty queue tops out near
// roster-size). Robust to onset timing: identical result whether the leap hits
// 04:10 or 04:26, because the chain finishes in the calm. Start EARLY (_AFTER
// before the earliest plausible onset); a later _AFTER lands tighter but risks
// a miss if the storm beats it. Off by default — enable with _FULL=1 + N>1.
const LADDER_PROACTIVE_FULL   = String(process.env.MONITOR_LADDER_PROACTIVE_FULL ?? '0') === '1';
const LADDER_SEED_MAX_INFLIGHT = Math.max(1,
  parseInt(process.env.MONITOR_LADDER_SEED_MAX_INFLIGHT ?? '1', 10) || 1);
// Pre-armed fire sessions: park a logged-in page on SAN's "Add To Queue"
// screen for every driver whose fire is near, so the fire itself is a ~1 s
// click instead of a ~3.5 s Chromium launch (see botService "Pre-armed fire
// sessions"). PREARM_AHEAD_SECS controls how far ahead of the projected fire
// time we arm each driver.
const PREARM_ENABLED    = (process.env.MONITOR_PREARM_ENABLED ?? 'true') !== 'false';
const PREARM_AHEAD_SECS = parseInt(process.env.MONITOR_PREARM_AHEAD_SECS ?? '240', 10);
// Fleet-wide storm-readiness lead (2026-07-27): the whole watched fleet arms as
// soon as the queue is MOVING toward the day's earliest target, or that earliest
// target is projected within PREARM_LEAD_SECS (20 min) of being reached —
// whichever comes first. This replaces the old "arm for the entire burst window"
// rule (which held ~60–75 SAN sessions warm across the dead-calm pre-storm hour
// and the post-storm plateau for no gain). Movement catches a fast onset; the
// earliest-target projection catches a gradual pre-ramp creep even while the rate
// is still below the movement threshold (the 07-26 04:47 case). 20 min is a
// generous lead — arming the fleet takes seconds — so no driver fires cold.
const PREARM_LEAD_SECS  = parseInt(process.env.MONITOR_PREARM_LEAD_SECS ?? '1200', 10);
// Wall-clock prearm floor (2026-07-28, user request; moved 03:30→03:20 2026-08-06):
// arm the whole fleet from this PT time regardless of what the projections say —
// a deterministic "armed by" guarantee on top of the dynamic triggers (which can
// still arm EARLIER on movement, never later). 03:20 leaves ~40 min before the
// earliest onset ever observed (04:00, and drifting ~7 min/wk earlier — move this
// up if the trend continues). Bounded to the storm-watch window so the fleet
// doesn't sit armed all day. Format 'HH:MM' PT; parse failures fall back to 03:30.
const PREARM_CLOCK_MIN  = parsePrearmClockPT(process.env.MONITOR_PREARM_CLOCK_PT ?? '03:20');
// Position-proximity arming: bursts are POSITION-locked, not time-locked —
// storm onset lands at queue 60–85 every morning (May–Jun logs: median 71)
// while its clock time swings 42 minutes. secondsUntilFire is a rate-based
// GUESS that a chunk storm invalidates in one tick, so once the queue nears
// the storm zone every waiting driver gets armed regardless of how far away
// their fire looks. 2026-07-28: 45→22 — July storms now BEGIN at queue 26–36
// (57-day re-analysis), so 45 armed after the storm had started; 22 sits just
// under the July onset floor. Arming never fires anyone, so the only cost is
// session-hours. Recalibrate when the regime drifts again.
const PREARM_QUEUE_POS  = parseInt(process.env.MONITOR_PREARM_QUEUE_POS ?? '22', 10);

// ─── Fire pacing gate (MONITOR_FIRE_PACING: off | shadow | on) ───────────────
// The median overshoot is self-inflicted latency: firing ~30 drivers in ONE
// second spikes inflight → SAN commit slows 6s→12s → drift 44→77 → overshoot
// (08-12 proof: same storm, drift @inflight<20 = 44 vs @≥20 = 77). This gate
// releases the sorted (most-overdue-target-first) batch metered so inflight
// stays ≤ PACE_MAX, keeping fires in the low-drift regime the cap-45 lead can
// cover. RISK (why shadow-first): a fire held past its window overshoots anyway,
// so held drivers with no runway (queue already within URGENCY_MARGIN of target)
// fire immediately; the rest retry next ~1s poll as inflight drains.
//   off    — unchanged (launch the whole batch at once).
//   shadow — launch unchanged, but COMPUTE + LOG what pacing would do and the
//            projected paced-vs-unpaced peak inflight & drift. Zero behaviour
//            change; the go/no-go data for `on`.
//   on     — actually hold over-cap, non-urgent fires to the next tick.
const FIRE_PACING_MODE     = String(process.env.MONITOR_FIRE_PACING ?? 'off').toLowerCase();
const PACE_MAX_INFLIGHT    = Math.max(1, parseInt(process.env.MONITOR_PACE_MAX_INFLIGHT ?? '12', 10));
// A driver whose live queue is already within this many positions of its target
// has no runway to be held (holding → guaranteed overshoot) → always release.
const PACE_URGENCY_MARGIN  = Math.max(0, parseInt(process.env.MONITOR_PACE_URGENCY_MARGIN ?? '25', 10));
// Concentration gate: only ENGAGE pacing when it would hold at least this many
// fires — i.e. a genuine same-tick pile-up. 10-day sim finding: pacing HELPS the
// concentrated storm days (08-07/08/09/11/12) but HURTS the calm/low-concentration
// days (08-05/06 got worse — re-timing penalty with no drift to save). A small
// batch produces few holds, so this threshold makes calm mornings behave exactly
// like `off`; only real pile-ups (batch ≳ MAX+MIN_HOLD, or high standing inflight)
// trip it.
const PACE_MIN_HOLD        = Math.max(1, parseInt(process.env.MONITOR_PACE_MIN_HOLD ?? '5', 10));
// Drift model (matches the shipped predictive lead) for the projection log only.
const paceDriftEst = (inflight) => Math.round(19 + 0.86 * inflight);

// Pure pacing planner: given the batch's targets already sorted most-overdue
// first, the live inflight, and the live queue depth, decide which fires to
// release this tick. Releases up to (PACE_MAX − inflight) slots; a driver with
// no runway (queue already within URGENCY_MARGIN of its target) is always
// released (holding it would only deepen its overshoot). Returns per-item
// release booleans + counts. Deterministic and side-effect free (unit-tested).
function planFirePacing(sortedTargets, inflight, waitingCount, minHold = PACE_MIN_HOLD) {
  let slots = Math.max(0, PACE_MAX_INFLIGHT - inflight);
  const releases = [];
  let fired = 0, held = 0, urgent = 0;
  for (const target of sortedTargets) {
    const noRunway = waitingCount >= target - PACE_URGENCY_MARGIN;
    const release  = slots > 0 || noRunway;
    if (release) {
      if (noRunway && slots <= 0) urgent++;
      if (slots > 0) slots--;
      fired++;
    } else {
      held++;
    }
    releases.push(release);
  }
  // Concentration gate: unless the pile-up is real (≥ minHold would be held),
  // release everyone — a calm morning must not pay the re-timing penalty for a
  // marginal hold (sim: pacing hurts low-concentration days).
  if (held < minHold) {
    return { releases: sortedTargets.map(() => true), fired: sortedTargets.length, held: 0, urgent: 0, engaged: false };
  }
  return { releases, fired, held, urgent, engaged: true };
}

// ─── Storm-onset early fire (MONITOR_ONSET_FIRE, default OFF) ────────────────
// SAN's display renders on a hard 5 s server tick (WS-verified 2026-07-08), so
// a competitor batch-add can jump the queue +39 inside ONE tick (07-08:
// 66→105) — every target inside the jumped gap fires born-over and lands +30…
// +50 late. No level-triggered rule ("fire when the number reaches target−10")
// can beat that: the number that says "fire" is already stale. This lever
// instead fires drivers BEFORE the chunk, the moment the storm-onset signature
// appears — spending bounded, opted-in undershoot to eliminate unbounded
// overshoot. All quantities are POSITIONS (never time): X is how many
// positions early a driver may be placed, enforced against effectiveQueue —
// a PROVEN lower bound of the true tail (display ∪ fleet landings) — so the
// worst case (storm dies the instant we click) lands the driver at the
// estimate itself: undershoot ≤ ONSET_CAP by construction.
//   MONITOR_ONSET_FIRE:  '0' off (default) | 'shadow' log-only | '1' live
//   Onset signature: queue inside [ZONE_MIN, ZONE_MAX] AND (sustained rate ≥
//   ONSET_RATE or a RENDER step ≥ ONSET_STEP). Thresholds are tuned to the
//   RAMP, not the peak (07-10: the +10 trigger step happened at q54, one
//   position below the old ZONE_MIN=55 — onset armed 6 s late at 15/s; 07-11:
//   the ramp's first acceleration was +5 at q41, below both old thresholds —
//   armed 11 s late at 12/s; being those seconds earlier in SAN's processing
//   line is the difference between landing on target and +40).
//
//   CALM-MORNING GUARD (dynamic cap): the early-fire allowance in force at any
//   instant is  min(ONSET_CAP, max(POS_MAX_LEAD, 2 × biggest render step of
//   the last ONSET_EVIDENCE_WINDOW_MS))  — a lone +5 flurry on a calm morning
//   unlocks only ~10 early (≈ the normal lead: no extra undershoot spent),
//   while a real chunk (+10…+42) unlocks the full cap within one render.
//
//   The detector is RENDER-aware: SAN's display only changes every ~5 s, so
//   steps are measured between display CHANGES, and the false-alarm cutoff is
//   time-based (ONSET_QUIET_MS without storm evidence → disarm) instead of
//   counting 1 s poll ticks, 4 of every 5 of which look calm between renders
//   (the bug that force-disarmed mid-storm on 07-09 and needed the
//   QUIET_TICKS=12 band-aid — MONITOR_ONSET_QUIET_TICKS is now retired).
const ONSET_FIRE_MODE   = String(process.env.MONITOR_ONSET_FIRE ?? '0').toLowerCase();
const ONSET_FIRE_LIVE   = ONSET_FIRE_MODE === '1';
const ONSET_FIRE_SHADOW = ONSET_FIRE_MODE === 'shadow';

// ─── Place-anyway fallback (MONITOR_PLACE_ANYWAY) ──────────────────────────
// The overshoot rails (queue_already_past_max, projection_exceeds_max) protect
// ACCURACY by declining to fire when the projected landing is past max. Their
// failure mode is that the driver is left OUT of the queue entirely — on the
// 2026-08-25 leap, #4354/#631/#0360 were armed and single-click-ready, held by
// the −65 floor while the queue read 105 for four ticks, then the queue leapt
// to 167 (past the 40-wide fire window in one poll) and the projection rail
// dropped all three. For the driver, a bad position beats no position.
//
// When on, an overshoot rail becomes a best-effort FIRE instead of a miss:
//   off  (default) — unchanged: record the miss, leave the driver out.
//   warm           — fire best-effort ONLY if the armed single-click session
//                    is still open (the proven <3 s path). If not armed, fall
//                    back to the miss (a cold fire on a guaranteed-overshoot
//                    driver mid-leap lands ~+160 s later and inflates everyone
//                    else's drift — see the warm-refire ladder note). This is
//                    the recommended setting: it recovers exactly the armed
//                    drivers the rails were throwing away, zero new cold fires.
//   cold (or 1)    — fire best-effort ALWAYS (warm if armed, cold otherwise).
//                    Guarantees literally nobody is left out, at the cost of
//                    cold-path landings and extra self-inflicted drift.
// Best-effort landings overshoot by +50..+70, which is > the |err|≤30 bias
// outlier filter, so they never poison the bias/drift learning.
const PLACE_ANYWAY_MODE    = String(process.env.MONITOR_PLACE_ANYWAY ?? 'off').toLowerCase();
const PLACE_ANYWAY_ON      = PLACE_ANYWAY_MODE === 'warm' || PLACE_ANYWAY_MODE === 'cold' || PLACE_ANYWAY_MODE === '1';
const PLACE_ANYWAY_COLD_OK = PLACE_ANYWAY_MODE === 'cold' || PLACE_ANYWAY_MODE === '1';
// 2026-07-28: zone floor 40→20 — the regime moved (July onsets begin at queue
// 26–36, 20 of 21 days below the old floor, so detection armed a chunk late by
// construction). Safe by the calm-guard above: a 9-week replay found pre-storm
// flurries in the 20–40 band on 37/57 days, worst step +5 ⇒ cap = 10 on every
// one — identical to the normal lead. Onset fires only land EARLY, so a lower
// floor cannot add overshoot.
// Cumulative-evidence calm guard (MONITOR_ONSET_CUM, default on, '0' reverts to
// the single-biggest-step rule): the dynamic cap sizes the early-fire allowance
// from the SUM of render steps in the evidence window, not the biggest one. A
// storm ramp is many renders in quick succession — 08-16: +4,+6,+6 inside ~10 s
// (16 cumulative) while the biggest single step was 6, so 2×max held the cap at
// 12 and the +21 leap one render later swallowed every target it crossed at
// +26…+48. A calm-day flurry is still a lone +5 in the 20 s window → identical
// unlock (~10) under either rule; only sustained multi-render ramps — the
// storm signature — unlock the full cap, one to two renders sooner.
const ONSET_CUM         = String(process.env.MONITOR_ONSET_CUM ?? '1') !== '0';
const ONSET_ZONE_MIN    = parseInt(process.env.MONITOR_ONSET_ZONE_MIN ?? '20', 10);
const ONSET_ZONE_MAX    = parseInt(process.env.MONITOR_ONSET_ZONE_MAX ?? '90', 10);
const ONSET_RATE        = parseFloat(process.env.MONITOR_ONSET_RATE   ?? '1.2');
const ONSET_STEP        = parseInt(process.env.MONITOR_ONSET_STEP     ?? '5', 10);
const ONSET_CAP         = parseInt(process.env.MONITOR_ONSET_CAP      ?? '25', 10);
const ONSET_QUIET_MS    = parseInt(process.env.MONITOR_ONSET_QUIET_MS ?? '25000', 10);
// Render steps older than this no longer describe the storm's current violence
// (drives the dynamic cap above). Internal — ~4 render cycles.
const ONSET_EVIDENCE_WINDOW_MS = 20000;
// ─── Backlog-aware onset cap + target-horizon guard (2026-07-19) ─────────────
// 07-15…07-18 forensics (5-morning replay, 314 fires): mid-ramp fires landed
// (landed − queue@fire) = +20…+61 past the queue they fired at — SAN's
// PROCESSING BACKLOG (adds already in its pipe ahead of our click; position is
// stamped at click-processing time). The flat cap-20/25 onset allowance is half
// the needed size mid-ramp (needs 30–55) yet TOO DEEP at the storm's death
// (07-15 #0767 −12, 07-16 #0082 −18, 07-19 #0003 −19 — all fired early-by
// 19–20 just as arrivals stopped, all targets ≥196). Two additions:
//
//  BACKLOG BOOST — the cap may exceed the base dynamic cap up to ONSET_CAP_MAX
//  only while a deep backlog is PROVEN live: boost = display slope (pos/s over
//  the last 10 s of render steps) × age of the oldest in-flight fire not yet
//  VISIBLE in V Holding (botService.oldestUnseenFireAgeMs, minus the ~3.5 s
//  render+poll baseline). Visibility — not confirm latency — separates real
//  processing backlog (07-18: unseen 10 s+, backlog 38–54) from mere WAIT-
//  screen stream-back lag (07-19: 12 s confirms but visible in ~3 s, backlog
//  ~14), the case that must NOT deepen the cap (replay: deepening on confirm
//  latency alone lands −19…−26 on 07-15/07-19).
//
//  TARGET-HORIZON GUARD — every observed storm since mid-June has run to a
//  total of ≥190 positions (July: 200–232 five mornings straight), and every
//  onset undershoot breach sat at target ≥196, exactly where storms die. So
//  the deep allowance is prior-safe only below that boundary: targets ≤
//  SAFE_HORIZON get the full (possibly boosted) cap; SAFE_HORIZON…MID_HORIZON
//  get at most MID_CAP; above MID_HORIZON the onset rule is off entirely (the
//  plain lead rule fires them on proven queue — post-storm drain lands −6…−9,
//  vs the −12…−19 the cap produced there).
//
//  Replay over the 5 real mornings (anchored arrival-envelope method): p90
//  overshoot +35→+31, worst +59→+47, zero undershoot breaches on all days
//  (actual: 9). A clairvoyant oracle bounds these mornings at p90 ≈ +24 — the
//  residual is SAN's arrival physics, not policy slack.
//
//  DEEP CAP RETIRED 2026-07-21 → default back to ONSET_CAP (25). The overshoot
//  it fought is now attacked at its SOURCE by the fast page release (botService
//  FIRE_RELEASE_MS): the +30→+50 regression was self-inflicted pipeline clog
//  (fleet grew ~15→68 → 25 fires/tick jammed the browsers → SAN slot-latency
//  0.3 s→1.6 s), which the declog fixes with ZERO undershoot cost. Firing the
//  corridor DEEPER (26–45 early) only added undershoot risk (−44 if a storm
//  stalls) for marginal overshoot gain — redundant once the pipeline is clear.
//  The boost math below still runs but is now ceilinged at the proven 25, so the
//  early-fire undershoot exposure returns to the deployed onset level. Set
//  MONITOR_ONSET_CAP_MAX=45 in .env to re-enable the deep cap if a future storm
//  ever needs it (e.g. the declog underdelivers on a genuine SAN-side backlog).
const ONSET_CAP_MAX         = parseInt(process.env.MONITOR_ONSET_CAP_MAX         ?? '25', 10);
const ONSET_SAFE_HORIZON    = parseInt(process.env.MONITOR_ONSET_SAFE_HORIZON    ?? '170', 10);
const ONSET_MID_HORIZON     = parseInt(process.env.MONITOR_ONSET_MID_HORIZON     ?? '200', 10);
const ONSET_MID_CAP         = parseInt(process.env.MONITOR_ONSET_MID_CAP         ?? '15', 10);
const ONSET_VIS_BASELINE_MS = parseInt(process.env.MONITOR_ONSET_VIS_BASELINE_MS ?? '3500', 10);
// Growth-scaled lead (MONITOR_GROWTH_LEAD, default ON — '0' disables): the
// plain-rule lead additionally capped at 2 + 3×growthRate positions. The
// drift floor (5) + bias (≈10) spend the full lead-10 on CALM pre-storm
// mornings where growth during the ~1.5 s commit is ~0 — six of the nine
// 07-15…07-19 undershoot breaches (−11…−13) were exactly this. At storm rates
// (≥2.7/s) the cap is ≥10, i.e. a no-op; it never delays a burst fire.
const GROWTH_LEAD_ENABLED   = (process.env.MONITOR_GROWTH_LEAD ?? '1') !== '0';
// Undershoot-rescue detector (MONITOR_UNDER_RESCUE: '0' off | 'shadow'
// log-only, default). A landing below target−10 is RECOVERABLE once the storm
// dies: the tail keeps growing (07-19: display 232→251 within 90 s of the
// storm end, 313 by 05:09), and a server-verified remove + armed re-add at
// calm lands at tail+1 — in-band. Shadow mode only LOGS the moment such a
// rescue would fire, to size the opportunity before any automation acts on a
// paying driver's queue entry.
const UNDER_RESCUE_MODE     = String(process.env.MONITOR_UNDER_RESCUE ?? 'shadow').toLowerCase();
// Sacrificial tail probe (default OFF) — dedicated vehicle add→read→remove
// cycles during the storm feed exact true-tail samples to the fleet probe.
// See tailProbeService.js for the full rationale and safety rails.
const TAIL_PROBE_ENABLED = process.env.MONITOR_TAIL_PROBE === '1';
// Only probe while a fire is actually imminent. Without this, any morning —
// calm ones included — would probe continuously from queue 45 until the last
// (highest) target fired, burning the daily cycle cap on days that already
// land 89–100% within ±10. Storm days are unaffected: inside the burst zone
// secsToFire collapses to seconds, so the probe stays continuously active
// exactly where the chunk-straddle misses live. Calm days get short probe
// windows just ahead of each fire cluster — where the samples still sharpen
// the landing — instead of hours of add/remove churn.
const TAIL_PROBE_AHEAD_SECS = parseInt(process.env.MONITOR_TAIL_PROBE_AHEAD_SECS ?? '90', 10);
// Borrowed tail probe (MONITOR_BORROW_PROBE=1, default OFF): when no dedicated
// probe account exists, lend the probe the highest-target watched drivers to get
// true-tail samples between SAN's blind 5 s display steps (the observation prize
// — worth ~21 positions of overshoot on a ramp storm like 07-21).
//
// ⚠ 2026-07-04 PRODUCTION FAILURE (the design this now fixes): borrowing ran on a
// global calm gate and retired the WHOLE roster only when the storm arrived; the
// queue rocketed 40+/s and the mass hand-back couldn't finish before the queue
// blew past the borrowed drivers' targets → they fired BORN-OVER and COLD
// (#0911 +61, #1237 +72, #1965 +85, 4 past-max misses). ROOT CAUSE: retiring on a
// global signal is too late; by the time "the storm" is detected, a driver whose
// target is nearby has no runway left.
//
// FIX (2026-07-22, PER-DRIVER rate-aware retire — see borrowSafeToHold /
// borrowRetireBuffer): each driver is kept as a probe ONLY while the queue is
// more than a RATE-SCALED buffer below their own target — i.e. while there is
// provably ≥ BORROW_RETIRE_LEAD_SECS of runway to remove them and re-arm. The
// buffer is max(+RETIRE_BUFFER, rate × RETIRE_LEAD_SECS), so a fast burst forces
// an early hand-back automatically; a driver drops out the instant the storm
// gets within their runway, is server-verify-removed by tailProbeService, and is
// re-armed by the prearm pool for an on-time armed fire. This lets us probe
// THROUGH the storm using far-target drivers, while making the 07-04 strand
// impossible by construction: we never hold a driver we can't get back. The
// preferred workhorse (BORROW_PROBE_VEHICLE, default 4000) is borrowed first but
// protected by the exact same rule.
const BORROW_PROBE_ENABLED = process.env.MONITOR_BORROW_PROBE === '1';
const BORROW_PROBE_MAX     = parseInt(process.env.MONITOR_BORROW_PROBE_MAX    ?? '2', 10);
const BORROW_PROBE_MARGIN  = parseInt(process.env.MONITOR_BORROW_PROBE_MARGIN ?? '60', 10);
// Preferred probe vehicle (user-designated, 2026-07-22): borrowed FIRST when
// it's a valid, safe candidate, so a chosen workhorse account carries the probe
// load before we lend anyone else's. Still retired by the SAME rate-aware +buffer
// rule below — it is protected exactly like every other borrowed driver.
const BORROW_PROBE_VEHICLE = String(process.env.MONITOR_BORROW_PROBE_VEHICLE ?? '4000').trim();
// ─── PER-DRIVER rate-aware retire (2026-07-22, replaces the calm-only gate) ──
// The 07-04 failure was retiring TOO LATE: borrowing ran into the burst and the
// hand-back couldn't finish before the queue blew past the driver's target, so
// they fired born-over and COLD. The user's rule is "+RETIRE_BUFFER positions
// before target." But a fixed +20 is only ~0.5 s of runway at 40/s — far too
// little to remove + re-arm. So the effective buffer SCALES with the storm:
//   retireBuffer = max(RETIRE_BUFFER, ceil(rate × RETIRE_LEAD_SECS))
// and a driver is only kept as a probe while (target − queue) > retireBuffer,
// i.e. while there is provably ≥ RETIRE_LEAD_SECS of runway to hand them back
// and re-arm. The instant that runway shrinks below the lead, the driver drops
// from the roster → tailProbeService retires (server-verified remove) → the
// prearm pool re-arms → they fire their OWN target, armed and on-time. This is
// what makes storm-window borrowing safe: we only ever borrow drivers whose
// target is far enough away RIGHT NOW that we can always get them back.
const BORROW_RETIRE_BUFFER    = parseInt(process.env.MONITOR_BORROW_RETIRE_BUFFER ?? '20', 10);
const BORROW_RETIRE_LEAD_SECS = parseInt(process.env.MONITOR_BORROW_RETIRE_LEAD_SECS ?? '30', 10);
// Legacy calm-only rails kept for the emergency global kill (still honored as an
// OUTER guard: if the queue is past this OR the fleet-wide rate is berserk we
// stop taking NEW borrows regardless of per-driver math). Defaults widened so
// the per-driver rate-aware rule is the real control.
const BORROW_STOP_QUEUE    = parseInt(process.env.MONITOR_BORROW_STOP_QUEUE  ?? '400', 10);
const BORROW_STORM_RATE    = parseFloat(process.env.MONITOR_BORROW_STORM_RATE ?? '60');
// Fallback estimate for Playwright bot execution time (ms) before we have real
// data. Used to project how many positions will be added between the fire decision
// and when SAN assigns the queue slot. The actual estimate is the rolling median
// of the last MAX_LATENCY_SAMPLES bot runs (see botExecutionEstimateMs below) —
// this constant is only the cold-start default until we collect enough samples.
//
// 2026-06-07: lowered from 15000 → 7000 after #4377 over-shot target by 36
// positions on a cold-morning fire (botEst fallback × BURST_DRIFT_RATE_CAP = 45
// drift, actual queue grew by 4). Every real bot run observed across June so
// far clusters around 5-9 s; 15 s was a worst-case-with-OIDC-handshake value
// that hasn't matched reality since the session warmer rolled out. 7 s sits
// just above the observed median so we err slightly conservative without
// inflating cold-start drift to 3× reality.
const POS_BOT_EXEC_MS  = parseInt(process.env.MONITOR_POS_BOT_EXEC_MS  ?? '7000', 10);
// ─── SAN commit-latency awareness (MONITOR_COMMIT_LATENCY_LEAD, default OFF) ──
// The horizon above (effectiveBotExecMs) measures the BOT's own run time —
// decision → click. It is BLIND to SAN's own commit latency: the wall-clock gap
// between our click and SAN stamping the driver's slot. On a calm morning that
// gap is ~1–3 s; on the 2026-07-27 storm it stalled to 22–42 s as a ~34/s onset
// drained through the fire pool and SAN's server buckled. During that stall the
// queue kept climbing, so every pending fire landed 150+ positions past target
// (overshoot ↔ commit latency r=0.869). We now MEASURE that gap per fire
// (decision timestamp → landing stamp, recordCommitLatency below) and expose a
// rolling median (commitLatencyEstimateMs). When this flag is ON, the median is
// folded into horizonSeconds so drift/lead and secondsUntilFire reflect SAN's
// real commit stall, not just our bot run time. It NEVER relaxes the ±10
// undershoot contract: the resulting lead is still clamped by POS_MAX_LEAD (10)
// and growthLeadCap, so on a full storm it is already pinned (no behaviour
// change) and on moderate mornings it only tightens an under-predicted horizon.
// Default OFF so the measurement can be validated against a live storm before it
// influences any decision. The instrumentation (the median + logging) runs
// regardless of this flag — only the horizon inclusion is gated.
const COMMIT_LATENCY_LEAD = (process.env.MONITOR_COMMIT_LATENCY_LEAD ?? 'false') === 'true';
// Minimum assumed queue growth rate (drivers/second) used as a floor before historical
// data exists and during calm periods. Protects against cold-start on a busy morning.
// Tune down if drivers land too early; tune up if they still land too late.
const EMERGENCY_SURGE_RATE = parseFloat(process.env.MONITOR_EMERGENCY_SURGE_RATE ?? '0.5');
// Extra seconds added to the forecast horizon as a safety cushion.
const SAFETY_BUFFER_SECS   = parseInt(process.env.MONITOR_SAFETY_BUFFER_MS ?? '10000', 10) / 1000;
// Storm-watch window: SAN's morning rush can arrive anywhere in a wide span —
// July onsets crept to ~04:00, while Sunday peaks land ~05:40 (some as late as
// 06:44, well past the old fixed 5:30 cutoff that skipped them entirely). Widened
// 2026-07-27 to 3:00–8:00 AM PT, all days, so no storm — early, late, or shifted —
// is ever caught at the slow cadence.
//
// The wide window is affordable because the 1 s poll inside it is ACTIVITY-GATED
// (see the cadence decision in poll()): we only hit SAN at 1 s while the queue is
// actually moving, and idle at BURST_IDLE_POLL_MS through the long calm and the
// post-storm plateau. The 1 s cadence stays essential while active — the queue can
// jump 50+ positions in a single 5 s tick (Jun 04–06), skipping a 40-wide target
// window whole; 1 s spreads that burst across ~5 ticks so the window is catchable.
//
// All bounds env-configurable so the window can shift if SAN changes hours.
const BURST_START_HOUR       = parseInt(process.env.MONITOR_BURST_START_HOUR ?? '3', 10); // PT hour, inclusive
const BURST_END_HOUR         = parseInt(process.env.MONITOR_BURST_END_HOUR   ?? '8', 10); // PT hour, exclusive
const POLL_BURST_MS          = parseInt(process.env.MONITOR_BURST_POLL_MS   ?? '1000', 10);
const BURST_IDLE_POLL_MS     = parseInt(process.env.MONITOR_BURST_IDLE_POLL_MS ?? '5000', 10);
// Growth rate (positions/s) at or above which the queue counts as "moving" —
// arms prearm and holds the 1 s cadence. Below it the queue is treated as calm.
const MOVEMENT_RATE_PER_S    = parseFloat(process.env.MONITOR_MOVEMENT_RATE ?? '0.3');
// A scheduled fire this close (s) counts as imminent — holds the 1 s cadence even
// with no measurable growth (covers the last driver in a dying storm).
const IMMINENT_FIRE_SECS     = parseInt(process.env.MONITOR_IMMINENT_FIRE_SECS ?? '45', 10);
// ── MASTER FAIL-SAFE ─────────────────────────────────────────────────────────
// One flag to revert every 2026-07-27 cadence/prearm change to the conservative
// pre-change behavior: lock to 1 s for the WHOLE storm-watch window and pre-arm
// every waiting driver across it (never activity-gated, never released early).
// It trades SAN load for guaranteed readiness — flip it to '0'/'false' the moment
// the smart logic is suspected of missing or delaying a fire; no code deploy
// needed, just an env change + restart. Default ON (smart behavior).
const SMART_CADENCE = (process.env.MONITOR_SMART_CADENCE ?? 'true') !== 'false'
                   && process.env.MONITOR_SMART_CADENCE !== '0';
// During burst the measured growth rate can spike to 10–15/s for a single tick
// (e.g. 75 drivers join in 5 s). If we use that raw rate for drift estimation,
// drift = 15 × 15 s = 225 positions — instantly marking every driver with
// max < queue+225 as missed_impossible on the very first burst tick.
// Cap the growth rate used ONLY for drift math during the burst window.
// The uncapped rate still drives the fire-timing decision (secsToFire).
// 3.0/s ≈ the observed sustained plateau rate; tune via env if needed.
const BURST_DRIFT_RATE_CAP   = parseFloat(process.env.MONITOR_BURST_DRIFT_RATE_CAP ?? '3.0');
// ─── Fleet-landing true-tail probe (de-lag SAN's stale V-Holding count) ───────
// SAN's displayed queue lags the real tail by a median +6 (up to +56, analysis
// 2026-06-25). But every time one of OUR drivers lands, SAN tells us their exact
// position = the true tail at that instant. Because the morning queue is
// append-only, that landing is a valid LOWER BOUND on the tail forever after. So
// `effectiveQueue = max(displayedQueue, freshestLanding−1)` is a strictly better
// (never-over) estimate of the real queue. Firing on it catches the band instead
// of firing late on the stale display — cutting OVERSHOOT without ever firing
// early in true-position terms (undershoot stays ≥ −9 by construction, since
// effectiveQueue ≤ true tail). It only ever ADDS a fire, never a skip. Default OFF.
const FLEET_PROBE_ENABLED  = process.env.MONITOR_FLEET_PROBE === '1';
// Only trust a landing this fresh as the live tail (older ⇒ the display has caught up).
const FLEET_PROBE_FRESH_MS = parseInt(process.env.MONITOR_FLEET_PROBE_FRESH_MS ?? '8000', 10);
// Hard cap on how far the probe may lead the displayed queue — belt against a
// contaminated landing (re-add / dispatched / misread) firing a driver too early.
const FLEET_PROBE_MAX_LEAD = parseInt(process.env.MONITOR_FLEET_PROBE_MAX_LEAD ?? '40', 10);
// How many recent queue observations to keep for the short-window rate calculation.
const SHORT_WINDOW_POLLS   = 3;

function currentHourPT() {
  return parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour:     'numeric',
      hour12:   false,
    }),
    10,
  );
}

function isWithinOperatingHours() {
  const h = currentHourPT();
  return h >= OP_START_HOUR && h < OP_END_HOUR;
}

function isWithinPositionHours() {
  const h = currentHourPT();
  return h >= POS_START_HOUR && h < POS_END_HOUR;
}

/** Today's target position for a driver — the day-specific override when set,
 *  else the base scheduledPosition; null when the driver has no target today.
 *  Mirrors evaluatePositionScheduler's own resolution so the fleet-wide
 *  "earliest target" pre-pass and the per-driver scheduler never disagree. */
function resolveTargetPosition(state, todayDayKey) {
  let target = state.scheduledPosition;
  if (state.dayPositions) {
    try { target = JSON.parse(state.dayPositions)[todayDayKey] ?? null; }
    catch { target = null; }
  }
  return target || null;
}

// Returns true inside the storm-watch window: [BURST_START_HOUR, BURST_END_HOUR)
// PT — default 3:00–8:00 AM, all days. Governs storm readiness (prearm + the
// zero safety-buffer burst drift math); the 1 s poll cadence inside it is
// further activity-gated in poll() so the calm stretches don't hammer SAN.
function isWithinBurstWindow() {
  const h = currentHourPT();
  return h >= BURST_START_HOUR && h < BURST_END_HOUR;
}

/** Minutes since midnight PT — drives the wall-clock prearm floor. */
function currentMinutesPT() {
  const [h, m] = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).split(':');
  return (parseInt(h, 10) % 24) * 60 + parseInt(m, 10);
}

const QUEUE_URL = process.env.MONITOR_QUEUE_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-17';
const T1_URL = process.env.MONITOR_T1_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-8';
const T2_URL = process.env.MONITOR_T2_URL
  ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-9';

// After this many terminal polls with no sighting, requeue anyway.
// Guards against fast dispatches the poll may have missed entirely.
const MAX_TERMINAL_CHECKS = parseInt(process.env.MONITOR_MAX_TERMINAL_CHECKS ?? '5', 10);

// Hard cap on consecutive "already in queue" bot results before we stop
// auto-requeuing a driver for the rest of the day. Protects against the
// case where the bot keeps confirming the driver IS in queue but our V Holding
// parse can't see them — guarantees we don't burn 200+ SAN logins like #142 on
// 2026-06-07. Any *real* add (success && !alreadyQueued) resets the counter.
const MAX_CONSECUTIVE_ALREADY_QUEUED = parseInt(process.env.MONITOR_MAX_CONSECUTIVE_ALREADY_QUEUED ?? '3', 10);

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Proxy dispatcher for polling fetches ─────────────────────────────────────
// Built once at module load (constructing a ProxyAgent is expensive — has a
// connection pool, TLS context, etc.) but consulted via shouldUseProxy() per
// fetch so the circuit breaker can transparently flip everything to direct
// when the proxy goes bad. Uses a single sticky session — polling wants a
// consistent IP, not rotation.
function buildPollDispatcher() {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined;

  const user = (process.env.PROXY_USERNAME || '').replace('{session}', 'monitor-poll');
  const pass = process.env.PROXY_PASSWORD || '';

  // Embed credentials into the proxy URL so undici ProxyAgent can authenticate.
  // Format: http://user:pass@host:port  (works for HTTP CONNECT tunnelling)
  // Normalise: add http:// if the server value has no protocol.
  const normalised = /^https?:\/\//i.test(server) ? server : `http://${server}`;
  let proxyUrl;
  try {
    const u = new URL(normalised);
    if (user) { u.username = encodeURIComponent(user); u.password = encodeURIComponent(pass); }
    proxyUrl = u.toString();
  } catch {
    proxyUrl = normalised;
  }

  console.log('[Monitor] Proxy configured for polling →', new URL(proxyUrl).host);
  return new ProxyAgent(proxyUrl);
}

const pollDispatcher = buildPollDispatcher();

/**
 * Returns the dispatcher undici should use for this call: the cached
 * ProxyAgent when the circuit breaker says proxy is OK, undefined when it
 * isn't (kill switch, unconfigured, or breaker open). Called per-fetch so
 * the breaker can transparently flip mid-session.
 */
function currentPollDispatcher() {
  return proxyHealth.shouldUseProxy() ? pollDispatcher : undefined;
}

/**
 * Pattern-match an error to decide whether it's plausibly the PROXY's fault
 * (and so should count against the circuit breaker) vs. something downstream
 * (SAN returning 503, vehicle search returning "not found", etc., which says
 * nothing about proxy health).
 *
 * False positives just trip the breaker slightly more eagerly than ideal —
 * the consequence is we fall back to direct, which is exactly the safe move.
 */
function looksLikeProxyFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('fetch failed')
      || msg.includes('econnrefused')
      || msg.includes('econnreset')
      || msg.includes('etimedout')
      || msg.includes('enotfound')
      || msg.includes('proxy_connection_failed')
      || msg.includes('tunneling socket')
      || msg.includes('http 407'); // proxy auth required
}

// ─── Concurrency-limited job queue ───────────────────────────────────────────
// Caps simultaneous Playwright bot sessions so a wave of departures (e.g.
// 50 drivers dispatched at once) doesn't spawn 50 browser processes.
class JobQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running     = 0;
    this.pending     = []; // { fn, resolve, reject }
    this.totalQueued = 0;
    this.totalDone   = 0;
  }

  enqueue(fn) {
    this.totalQueued++;
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this._tick();
    });
  }

  _tick() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const { fn, resolve, reject } = this.pending.shift();
      this.running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this.totalDone++;
          this._tick();
        });
    }
  }

  get activeCount()  { return this.running; }
  get pendingCount() { return this.pending.length; }
}

const jobQueue = new JobQueue(BOT_CONCURRENCY);

// ─── In-memory state ─────────────────────────────────────────────────────────
/**
 * Map<driverId, DriverWatchState>
 *
 * DriverWatchState = {
 *   driverId:          number
 *   driverName:        string
 *   vehicleNumber:     string   — raw value from DB
 *   vehicleNorm:       string   — normalised for comparison
 *   isAuto:            boolean  — true = auto-watched (active driver), false = manual watch
 *   state:             'watching'|'in_queue'|'dispatched'|'at_terminal'|'requeuing'
 *   hasBeenSeen:       boolean  — true once observed in the queue this session
 *   addedAt:           Date
 *   lastSeenAt:        Date|null
 *   lastDispatchAt:    Date|null
 *   lastGoneAt:        Date|null
 *   lastRequeuedAt:    Date|null
 *   lastResult:        {success, position?, error?, message?}|null
 *   requeueCount:      number   — total since server start
 *   requeueCountToday: number   — resets at midnight Pacific
 *   lastPosition:      number|null
 *   atTerminalSince:   Date|null  — when driver left V Holding
 *   terminalSeen:      boolean    — true once spotted on T1 or T2
 *   terminalCheckCount:number     — polls elapsed while at_terminal
 *   terminalName:      'T1'|'T2'|null  — which terminal they're at
 *   terminalPosition:  number|null     — their position in that list
 * }
 */
const watches = new Map();

/** Track which driverIds are auto-managed (so we can remove deactivated drivers) */
const autoDriverIds = new Set();

/** Track which driverIds were explicitly added via "Watch Vehicle" on the Monitor page */
const manualWatchIds = new Set();

/** Today's date in PT — used to detect day rollover for counter reset */
let todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/**
 * Last calendar day (PT, YYYY-MM-DD) on which we re-armed the position
 * scheduler at the start of position hours. Null until the first 3 AM
 * transition observed since boot. Lets us run the auto-arm exactly once per
 * day, regardless of how many polls fire during the window.
 */
let positionWindowArmedForDate = null;

/** Stats from the most recent successful poll */
let lastPollStats = {
  pollAt:       null,
  totalInQueue: 0,
  dispatched:   0,
  waiting:      0,
  fetchMs:      0,
  queueUrl:     QUEUE_URL,
  error:        null,
};

let pollTimer    = null;
let refreshTimer = null;
// Event-driven poll nudge (fleet-probe): a fresh fleet landing re-evaluates
// the scheduler immediately instead of waiting out the current poll delay.
// scheduleFn is the active chain's scheduler (set by startMonitor); pollInFlight
// prevents a nudge from overlapping a running poll — if one is in flight, the
// pending flag makes the chain's own reschedule fire at 0 delay instead.
let scheduleFn   = null;
let pollInFlight = false;
let nudgePending = false;
function nudgePoll() {
  if (!scheduleFn) return;
  nudgePending = true;
  if (!pollInFlight && pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
    scheduleFn();
  }
}

// ─── Queue growth-rate tracking (for dynamic position-schedule lead) ──────────
// All rates are in drivers/second so they stay accurate even if poll intervals drift.
// prevWaitingCount: null on startup so the first tick doesn't produce a false surge.
// smoothedGrowthRate: EMA (α=0.7) of per-second growth rate — reacts fast to surges.
// lastObservationAt: timestamp (ms) when the latest queue snapshot was fetched.
// prevObservationAt: timestamp of the previous snapshot — used to get elapsed seconds.
// biasCorrection: median of recent (actual - target) landing errors, updated periodically.
//   If positive, drivers are landing too far back → added to prediction so bot fires earlier.
// biasPollCount: counts poll ticks to know when to refresh the bias correction.
let prevWaitingCount   = null;
let smoothedGrowthRate = 0;       // drivers/second
let lastObservationAt  = null;    // ms timestamp of latest observation
let prevObservationAt  = null;    // ms timestamp of previous observation
let biasCorrection     = 0;       // positions — loaded from position_tracking history
let biasPollCount      = 0;
const BIAS_REFRESH_EVERY = 20;    // recalculate bias every N poll ticks
// Freshest genuine landing of ANY fleet driver — the true-tail probe input
// (see FLEET_PROBE_ENABLED). Updated only from confirmed tail-joins so it can't
// be poisoned by re-adds / already-queued / failed rows.
let lastFleetLanding   = { position: 0, atMs: 0 };
// Timestamp of the last ladder fire this process dispatched (MONITOR_LADDER).
// While the chain is actively climbing (a ladder fire within the last 30s) and
// the queue motion is still chain-sized (< 1.0/s — a real storm is faster),
// the predictive band lead stays suppressed so our own chain's render steps
// can't masquerade as storm velocity and fire band drivers 20 deep.
let ladderLastFireMs   = 0;

// ─── Storm-onset tracker (MONITOR_ONSET_FIRE) ────────────────────────────────
// One instance per process, advanced once per poll tick with that tick's queue
// count and smoothed growth rate. Pure step function (exported for tests).
//
// RENDER-aware: SAN's display changes every ~5 s while we poll at 1 s, so a
// "step" only exists when the displayed value CHANGES; between renders the
// tracker neither gains evidence nor decays. Arming needs the signature inside
// the zone; once armed it stays armed while storm evidence keeps arriving
// (any render step ≥ ONSET_STEP or rate ≥ ONSET_RATE, zone no longer required
// — the storm has left the zone by definition), and disarms after
// ONSET_QUIET_MS without evidence. recentSteps (pruned to
// ONSET_EVIDENCE_WINDOW_MS) drives the dynamic calm-guard cap.
const freshOnsetState = () => ({
  active: false, prevQueue: null, lastEvidenceMs: 0, recentSteps: [], stepSeen: 0,
});
let onsetState = freshOnsetState();
// Last effective cap logged (backlog boost) — change-gated so the log shows the
// cap ladder, not one line per tick.
let lastLoggedOnsetCap = 0;

function onsetStep(st, { queue, rate, nowMs = Date.now() }) {
  const changed = st.prevQueue !== null && queue !== st.prevQueue;
  const step    = changed ? Math.max(0, queue - st.prevQueue) : 0;

  const recentSteps = st.recentSteps
    .filter((s) => nowMs - s.t <= ONSET_EVIDENCE_WINDOW_MS)
    .concat(step > 0 ? [{ t: nowMs, step }] : []);

  const evidence = step >= ONSET_STEP || rate >= ONSET_RATE;
  let { active, lastEvidenceMs } = st;

  if (evidence && (active || (queue >= ONSET_ZONE_MIN && queue <= ONSET_ZONE_MAX))) {
    active         = true;
    lastEvidenceMs = nowMs;
  } else if (active && nowMs - lastEvidenceMs > ONSET_QUIET_MS) {
    active = false;
  }

  return { active, prevQueue: queue, lastEvidenceMs, recentSteps, stepSeen: step };
}

/** Calm-morning guard: the early-fire allowance actually in force. Scales with
 *  the storm's observed violence — a lone +5 calm-day flurry unlocks only the
 *  normal lead (~10, i.e. no extra undershoot), a real chunk unlocks the full
 *  cap. backlogBoost (see the ONSET_CAP_MAX block) may raise it further, up to
 *  ONSET_CAP_MAX, while a deep SAN processing backlog is proven live. */
function onsetCapNow(st, backlogBoost = 0) {
  // Violence evidence: cumulative render steps in the window (MONITOR_ONSET_CUM,
  // see the constant block) — a ramp of small steps is a storm; one is a flurry.
  const evidence = ONSET_CUM
    ? st.recentSteps.reduce((a, s) => a + s.step, 0)
    : st.recentSteps.reduce((m, s) => Math.max(m, s.step), 0);
  const base = Math.min(ONSET_CAP, Math.max(POS_MAX_LEAD, 2 * evidence));
  return Math.min(ONSET_CAP_MAX, Math.max(base, Math.floor(backlogBoost)));
}

/** Live SAN-backlog estimate in positions: display slope (render steps of the
 *  last 10 s) × how long the oldest in-flight fire has been invisible in
 *  V Holding beyond the render+poll baseline. Zero unless the storm is active,
 *  the display is genuinely ramping (≥2/s), and at least one fire is provably
 *  stuck in SAN's pipe — all three gates measured, none extrapolated.
 *  unseenAgeMs is injectable for tests; production reads botService. */
function onsetBacklogBoost(st, { nowMs = Date.now(), unseenAgeMs = null } = {}) {
  if (!st.active) return { boost: 0, slope10: 0, visAgeS: 0 };
  const stepSum = st.recentSteps
    .filter((s) => nowMs - s.t <= 10_000)
    .reduce((a, s) => a + s.step, 0);
  const slope10 = stepSum / 10;
  if (slope10 < 2) return { boost: 0, slope10, visAgeS: 0 };
  const rawAge  = unseenAgeMs ?? require('./botService').oldestUnseenFireAgeMs(nowMs);
  const visAgeS = Math.min(25, Math.max(0, (rawAge - ONSET_VIS_BASELINE_MS) / 1000));
  return { boost: slope10 * visAgeS, slope10, visAgeS };
}
function recordFleetLanding(position) {
  if (!Number.isFinite(position) || position <= 0) return;
  const now   = Date.now();
  const stale = (now - lastFleetLanding.atMs) > FLEET_PROBE_FRESH_MS;
  // Keep the HIGHEST landing within the fresh window, not the latest-by-time.
  // The morning queue is append-only, so the true tail only rises; a landing
  // BELOW a recent one is a straggler from a driver who fired earlier at a
  // smaller queue (slow armed click under storm load), NOT a shrinking tail.
  // 2026-07-04 proof: at the 77→103 chunk step, landings arrived 96,95,93 then
  // 73,71,70 in the same second — latest-wins left the probe anchored at 72 and
  // BLIND, so targets 89–102 all fired at the stale 103 display (+25…+28). The
  // max is still ≤ the true current tail, so undershoot ≥ −9 is preserved.
  if (stale || position > lastFleetLanding.position) {
    lastFleetLanding = { position, atMs: now };
    // Event-driven decision: a fresh, HIGHER true-tail observation that the
    // next poll (up to 1 s away at burst cadence — a 20–40-position hole in a
    // storm) would act on. Re-evaluate now instead. Nudging only on an improved
    // estimate also avoids churning the poll on stale stragglers.
    if (FLEET_PROBE_ENABLED) nudgePoll();
  }
}

/** Undershoot-rescue detector (see UNDER_RESCUE_MODE — shadow/log-only). An
 *  undershoot landing is recoverable exactly when the storm has died AND the
 *  tail has grown back into the driver's band: a server-verified remove + armed
 *  re-add at that moment lands at tail+1, in-band. Mid-storm this must never
 *  trigger (the tail blows through the band in seconds; a re-add would chase
 *  the ramp and overshoot) — hence the calm-rate gate. Logs once per driver per
 *  day; no automation acts on it yet. */
function maybeFlagUnderRescue(state, target, waitingCount, growthRate) {
  if (UNDER_RESCUE_MODE === '0') return;
  const landed = state.landedPositionToday;
  if (!Number.isFinite(landed) || !Number.isFinite(target)) return;
  if (landed >= target - 10) return;          // within contract — nothing to rescue
  if (state.underRescueFlagged) return;       // one flag per day
  if (growthRate >= 1.0) return;              // storm still running — unsafe to re-add
  if (waitingCount < target - 5) return;      // tail hasn't re-reached the band yet
  state.underRescueFlagged = true;
  console.log(
    `[Pos] 🛟 UNDER-RESCUE (shadow): #${state.vehicleNumber} landed ${landed} vs target ${target} ` +
    `(${landed - target}); queue ${waitingCount} at calm ${growthRate.toFixed(2)}/s has re-reached the band — ` +
    `a server-verified remove + armed re-add NOW would land in-band (log-only; no action taken)`);
}

// ─── Borrowed-probe roster (MONITOR_BORROW_PROBE) ─────────────────────────────
// Decrypted creds for borrowed drivers, cached so we don't hit the DB every
// tick (the roster is stable for long stretches). borrowRosterInFlight makes
// the async reconcile self-throttling — one in flight at a time; the next tick
// converges anyway.
const borrowCredsCache    = new Map(); // driverId → { username, password }
let   borrowRosterInFlight = false;
let   _borrowRetireLogged  = false;    // one-shot log guard for the mass-retire message
// The single highest-target driver we pin as the (only) second borrow account
// for the day — see updateBorrowRoster. Reset each morning + on stopMonitor so
// the blast radius is always exactly {BORROW_PROBE_VEHICLE, this one driver}.
let   borrowPinnedSecondId = null;

/**
 * Calm-only borrow gate (pure — the 2026-07-04 safety rail). Borrowing is
 * ONLY allowed while the morning is genuinely calm; the instant the queue
 * nears onset OR the rate rises, this returns false and the whole roster is
 * mass-retired so every lent driver is handed back to the armed pool and fires
 * on time. A real driver must NEVER be held into the burst.
 */
function borrowAllowedInCalm(waitingCount, growthRate) {
  return waitingCount < BORROW_STOP_QUEUE && growthRate < BORROW_STORM_RATE;
}

/** Rate-aware retire buffer (positions): how far below a driver's target we must
 *  stop borrowing them to guarantee runway to remove + re-arm before their fire.
 *  Floor = BORROW_RETIRE_BUFFER (the user's +20); scales with the storm so a
 *  fast burst forces an early hand-back. Pure — exported for tests. */
function borrowRetireBuffer(growthRate) {
  return Math.max(BORROW_RETIRE_BUFFER, Math.ceil(Math.max(0, growthRate) * BORROW_RETIRE_LEAD_SECS));
}

/** Is this driver still SAFE to hold as a probe right now? Only while the queue
 *  is more than the rate-aware buffer below their target — i.e. there is provably
 *  ≥ BORROW_RETIRE_LEAD_SECS of runway to hand them back and re-arm. The instant
 *  this is false they must be retired (dropped from the borrow roster). */
function borrowSafeToHold(target, waitingCount, growthRate) {
  return (target - waitingCount) > borrowRetireBuffer(growthRate);
}
// Per-driver borrow audit (for the admin "Borrowed Drivers" table): proves a
// lent driver was cycled, retired, re-armed, and still landed on target.
//   driverId → { cycles, adds, firstBorrowedAt, lastBorrowedAt, retiredAt }
const borrowHistory       = new Map();
// Drivers an admin rescued this session — never borrow them again today, but
// they STILL get their normal real placement (rescue only stops the probing).
const borrowExcluded      = new Set();

/**
 * Reconcile the borrowed-probe roster with tailProbeService. Picks the
 * highest-target candidates (their real fire is furthest off), resolves creds,
 * hands the roster to the probe, then sets each watched driver's borrowedAsProbe
 * flag from the probe's ACTUAL held set — a retiring driver stays flagged until
 * truly removed, so the observation loop never sees a probe cycle.
 */
/**
 * DAMAGE MINIMIZATION (user, 2026-07-22) — pure selection: the borrow set is
 * ONLY ever two fixed accounts all day, the preferred workhorse (4000) and the
 * SINGLE highest-target driver, PINNED on first selection so it never rotates
 * as drivers retire (without the pin, the "second" slot would shift to the
 * next-highest driver each time one retired, so the day's blast radius could
 * exceed two). Each still only appears while it's a safe candidate. Returns the
 * chosen list and the (possibly newly-pinned) second id — no side effects, so
 * it's unit-testable. maxN caps the result (2).
 */
function selectBorrowAccounts(eligible, pinnedSecondId, maxN) {
  const preferred = eligible.find((c) => c.preferred); // the 4000 workhorse
  let pinned = pinnedSecondId;
  if (pinned == null) {
    const hi = eligible.filter((c) => !c.preferred).sort((a, b) => b.target - a.target)[0];
    if (hi) pinned = hi.driverId;
  }
  const second = eligible.find((c) => c.driverId === pinned);
  const chosen = [preferred, second].filter(Boolean).slice(0, maxN);
  return { chosen, pinnedSecondId: pinned };
}

async function updateBorrowRoster(candidates, todayDayKey, active) {
  if (borrowRosterInFlight) return; // declarative — next tick reconciles
  borrowRosterInFlight = true;
  try {
    const tp       = require('./tailProbeService');
    const disabled = new Set(tp.disabledBorrowedIds()); // self-disabled → leave alone
    const eligible = active
      ? candidates.filter((c) => !disabled.has(c.driverId) && !borrowExcluded.has(c.driverId))
      : [];
    const wasPinned = borrowPinnedSecondId;
    const sel = selectBorrowAccounts(eligible, borrowPinnedSecondId, BORROW_PROBE_MAX);
    borrowPinnedSecondId = sel.pinnedSecondId;
    if (borrowPinnedSecondId != null && borrowPinnedSecondId !== wasPinned) {
      const hi = eligible.find((c) => c.driverId === borrowPinnedSecondId);
      console.log(`[Borrow] pinned second probe → #${hi?.vehicle} (target ${hi?.target}); only #${BORROW_PROBE_VEHICLE} and this account will ever be borrowed today`);
    }
    const chosen = sel.chosen;

    const roster = [];
    for (const c of chosen) {
      let creds = borrowCredsCache.get(c.driverId);
      if (!creds) {
        const d = await Driver.findByIdWithCredentials(c.driverId);
        if (!d?.san_username || !d?.san_password) continue;
        creds = { username: d.san_username, password: decrypt(d.san_password) };
        borrowCredsCache.set(c.driverId, creds);
      }
      roster.push({ driverId: c.driverId, vehicle: c.vehicle, username: creds.username, password: creds.password });
    }

    tp.syncRoster({
      active,
      roster,
      dayKey:       todayDayKey,
      onTailSample: (pos) => recordFleetLanding(pos),
    });

    // Reconcile flags from what the probe actually holds now (retiring records
    // remain until their force-remove completes → driver stays checked-out).
    const borrowedNow = tp.tailProbeStats().borrowed;
    const held        = new Set(borrowedNow.map((b) => b.driverId));
    for (const [driverId, st] of watches) {
      st.borrowedAsProbe = held.has(driverId);
    }

    // Audit trail: accumulate per-driver borrow stats so the admin can confirm
    // a lent driver was cycled, retired, and still placed on target.
    const now = new Date();
    for (const b of borrowedNow) {
      const h = borrowHistory.get(b.driverId) ?? { cycles: 0, adds: 0, firstBorrowedAt: now, lastBorrowedAt: now, retiredAt: null };
      h.cycles         = Math.max(h.cycles, b.cycles || 0); // cycle = one add+remove
      h.adds           = h.cycles;
      h.lastBorrowedAt = now;
      h.retiredAt      = null; // still active
      borrowHistory.set(b.driverId, h);
    }
    // Mark retirement for anyone with history who is no longer held.
    for (const [driverId, h] of borrowHistory) {
      if (!held.has(driverId) && !h.retiredAt) h.retiredAt = now;
    }
  } finally {
    borrowRosterInFlight = false;
  }
}

/**
 * Admin/CLI rescue for a borrowed driver that appears stuck: force-retire the
 * probe (which force-removes the vehicle from SAN), exclude them from any
 * further borrowing today, and RE-ARM the position scheduler so they still get
 * their real target placement. Returns a status object. Never throws.
 */
async function rescueBorrowedDriver(driverId) {
  borrowExcluded.add(driverId);
  const state = watches.get(driverId);
  let retired = false;
  try {
    await require('./tailProbeService').retireBorrowed(driverId); // targeted: stop + force-remove this one
    retired = true;
  } catch (err) {
    console.error(`[Borrow] rescue retire failed for ${driverId}: ${err.message}`);
  }
  if (state) {
    state.borrowedAsProbe    = false;
    state.positionFiredToday = false; // let the scheduler fire their REAL target
    state.landedPositionToday = null; // stale probe-era landing must not label the fresh fire
    state.hasBeenSeen        = false;
    state.earlyJoinDetectedAt = null;
    state.earlyJoinAtPosition = null;
    const h = borrowHistory.get(driverId);
    if (h && !h.retiredAt) h.retiredAt = new Date();
    console.log(`[Borrow] 🛟 #${state.vehicleNumber} rescued — retired from probing, excluded for today, re-armed for real target`);
    broadcast('driver_state', { driverId, state: snap(state) });
  }
  return {
    ok:            !!state,
    driverId,
    vehicleNumber: state?.vehicleNumber ?? null,
    retired,
    rearmed:       !!state,
    excludedForToday: true,
  };
}
// Maximum |bias| we'll apply. Belt to medianRecentError's outlier filter (the
// braces) — bounds the worst-case prediction damage if a contamination path
// we haven't found yet pulls the median to an unhelpful value. 10 positions is
// enough for genuine calibration (real fires consistently land within ±15);
// anything larger is almost certainly bad input data, not real drift.
const BIAS_CAP_POSITIONS = parseInt(process.env.MONITOR_BIAS_CAP ?? '10', 10);
// Circular buffer of recent {count, observedAt} snapshots for short-window rate.
// Oldest entry first; capped at SHORT_WINDOW_POLLS + 1 entries.
const recentObservations = [];

// Time-bounded observation buffer for the predictive-lead velocity (independent
// of poll cadence — recentObservations is capped by COUNT and won't reliably
// span PRED_VEL_WINDOW_S once adaptive polling tightens). Holds ~2× the window.
const velocityObservations = []; // [{ t: ms, q: count }], oldest first
function recordVelocityObservation(count, atMs) {
  velocityObservations.push({ t: atMs, q: count });
  const cutoff = atMs - PRED_VEL_WINDOW_S * 2 * 1000;
  while (velocityObservations.length > 2 && velocityObservations[0].t < cutoff) {
    velocityObservations.shift();
  }
}
// Trailing slope (positions/sec) over the last PRED_VEL_WINDOW_S, floored at 0
// and capped at PRED_VEL_CAP so a single-tick surge can't inflate the lead.
function observedVelocity(nowMs) {
  if (velocityObservations.length < 2) return 0;
  const newest = velocityObservations[velocityObservations.length - 1];
  const target = nowMs - PRED_VEL_WINDOW_S * 1000;
  // oldest sample at or before the window start (fall back to the oldest we have)
  let base = velocityObservations[0];
  for (const o of velocityObservations) { if (o.t <= target) base = o; else break; }
  const dt = (newest.t - base.t) / 1000;
  if (dt <= 0) return 0;
  return Math.min(Math.max(0, (newest.q - base.q) / dt), PRED_VEL_CAP);
}

// ─── Sustained-growth tracker (ladder SEED gate — MONITOR_LADDER_SEED_GAP) ────
// The short PRED_VEL_WINDOW_S slope is too noisy to tell "the list is building
// toward a storm" from dead-calm bouncing (08-23: queue jittered 3–10 for 15
// min, then ramped 15→29 over ~90 s, then leapt). The seed tier must NOT spend
// undershoot budget on proximity alone during that dead calm — it must be
// informed by genuine growth. This buffer keeps a longer window (SEED window)
// so sustainedRise() reports the NET positions the queue has climbed. A dead
// morning nets ~0; a real ramp nets clearly positive well before the leap.
// Cumulative count of OUR OWN ladder/seed adds — subtracted from the queue
// before measuring rise (see below). Monotonic; the DIFFERENCE between two
// samples is all sustainedRise uses, so it never needs a daily reset.
let ladderAddsCommitted = 0;
// Proactive-shadow walk (MONITOR_LADDER_PROACTIVE=shadow): drivers already
// logged as "would proactively seed" today, so the shadow pass advances one per
// tick through the roster instead of re-logging the lowest target forever.
// Keyed by driverId; cleared when the PT date rolls over.
let ladderShadowSeeded = new Set();
let ladderShadowDay    = null;
const seedQueueHistory = []; // [{ t, q, ours }], oldest first
function recordSeedQueueObservation(count, atMs) {
  seedQueueHistory.push({ t: atMs, q: count, ours: ladderAddsCommitted });
  const cutoff = atMs - (SEED_RISE_WINDOW_S + 30) * 1000; // window + a little slack
  while (seedQueueHistory.length > 2 && seedQueueHistory[0].t < cutoff) {
    seedQueueHistory.shift();
  }
}
// Net EXTERNAL queue rise (positions) over the last SEED_RISE_WINDOW_S: the raw
// climb minus OUR OWN ladder/seed adds in the window. This is critical — the
// displayed queue includes our committed seeds, so a raw rise would let our own
// seeds re-open and deepen the gate: a slow-motion tick-pipe feedback loop that
// would empty the band roster on a false-alarm morning. Subtracting our adds
// makes the gate track genuine competitor/organic demand only. Signed — a flat
// or our-adds-only climb returns ≤ 0, so the gate stays shut.
function sustainedRise(nowMs) {
  if (seedQueueHistory.length < 2) return 0;
  const newest = seedQueueHistory[seedQueueHistory.length - 1];
  const target = nowMs - SEED_RISE_WINDOW_S * 1000;
  let base = seedQueueHistory[0];
  for (const o of seedQueueHistory) { if (o.t <= target) base = o; else break; }
  const rawRise  = newest.q - base.q;
  const ourAdds  = newest.ours - base.ours;
  return rawRise - ourAdds;
}

// ─── Adaptive polling (poll faster as drivers approach their fire window) ────
// Current effective interval (ms). Recalculated at the end of every poll based
// on the smallest secondsUntilFire across all armed position-scheduled drivers.
// Lives at module scope so getState() / nextPollIn() can report it.
let currentPollDelayMs = POLL_INTERVAL_MS;

/**
 * Pure function: returns the poll interval (ms) appropriate for a given
 * "seconds until next driver needs to fire". Tighter cadence near the fire
 * window, idle cadence otherwise. Also used by the fire-before-next-poll guard
 * so both decisions stay consistent.
 */
function expectedNextPollMs(secondsUntilFire) {
  if (!Number.isFinite(secondsUntilFire) || secondsUntilFire > 60) return POLL_INTERVAL_MS;
  if (secondsUntilFire > 20) return POLL_NEAR_FIRE_MS;
  return POLL_AT_FIRE_MS;
}

// ─── Storm-watch cadence & prearm decision helpers (pure, unit-tested) ────────
// Extracted from poll() so the 2026-07-27 activity-gated cadence, dynamic prearm,
// and morning-complete release are covered by tests in isolation. All O(1), no
// I/O, no allocation beyond a tiny result object — called once per poll tick.

/** Fleet storm-readiness for prearm. The queue is "building" toward the day's
 *  earliest still-unfired target when it is actively MOVING (onset armed, or
 *  growth ≥ MOVEMENT_RATE_PER_S) OR that target is projected within `leadSecs`
 *  of being reached. secsToEarliestTarget is ∞ when the queue is flat (rate ≤ 0)
 *  or every target is already fired (earliestTarget ∞) — so neither the pre-storm
 *  calm nor the post-storm plateau reports building. */
function computeStormReadiness({ onsetActive, growthRate, earliestTarget, waitingCount, leadSecs }) {
  const secsToEarliestTarget =
    (growthRate > 0 && Number.isFinite(earliestTarget))
      ? (earliestTarget - waitingCount) / growthRate
      : Infinity;
  const stormBuilding =
    Boolean(onsetActive) || growthRate >= MOVEMENT_RATE_PER_S || secsToEarliestTarget <= leadSecs;
  return { stormBuilding, secsToEarliestTarget };
}

/** Parse 'HH:MM' (PT wall clock) → minutes since midnight. Falls back to 03:30
 *  (210) on anything malformed so a bad env value can never disable the
 *  deterministic prearm floor. */
function parsePrearmClockPT(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return 210;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return 210;
  return h * 60 + min;
}

/** Fleet prearm gate (2026-07-28). Smart mode arms on the dynamic signal OR the
 *  wall-clock floor (inside the storm-watch window only, so the fleet is not
 *  held armed all day) — the clock can only make arming EARLIER than the
 *  dynamic triggers alone, never later. Fail-safe (!smart) keeps the pre-change
 *  rule: armed across the whole window. */
function computePrearmReady({ smart, stormBuilding, inWatchWindow, minutesPT, clockMinutes }) {
  if (!smart) return inWatchWindow;
  return Boolean(stormBuilding) || (inWatchWindow && minutesPT >= clockMinutes);
}

/** Whether the queue is "active" (hold the 1 s cadence): onset armed, measurable
 *  growth, or a fire imminent — the three ramp signals, all silent on the calm
 *  and the post-storm plateau (where an absolute-level test would wrongly stay). */
function isQueueActive({ onsetActive, growthRate, minSecondsUntilFire }) {
  return Boolean(onsetActive)
    || growthRate >= MOVEMENT_RATE_PER_S
    || (Number.isFinite(minSecondsUntilFire) && minSecondsUntilFire <= IMMINENT_FIRE_SECS);
}

/** Next poll delay (ms). Encodes the whole storm-watch cadence in one place:
 *   • !smart (fail-safe) → 1 s for the entire window, else normal adaptive;
 *   • outside the window, OR the morning's fires are all done (no fire pending)
 *       → normal adaptive (30–90 s), even inside the window;
 *   • queue active → 1 s burst; otherwise the idle floor, never slower than the
 *       adaptive rate a nearer fire would ask for. */
function computePollDelayMs({ smart, inWatchWindow, firePending, queueActive, burstMs, idleMs, adaptiveMs }) {
  if (!smart)                            return inWatchWindow ? burstMs : adaptiveMs;
  if (!(inWatchWindow && firePending))   return adaptiveMs;
  return queueActive ? burstMs : Math.min(idleMs, adaptiveMs);
}

// ─── Bot latency tracking (median + freshness window) ────────────────────────
// Each sample is { ms, recordedAt } — recordedAt lets us discard data older
// than LATENCY_FRESHNESS_MS so a one-time architectural change (e.g. the 5/29
// warmer rollout) doesn't keep dragging the prediction toward stale numbers.
//
// We use the MEDIAN, not P95: with the warmer running, real bot times cluster
// tightly around 7-8 s. P95 was useful when the distribution had a long tail
// of 25 s cold logins; that tail is gone. P95 over current samples drags the
// horizon up by 50%+, which causes the over-predicted drift we saw on 5/29.
//
// In-memory ring buffer. Push is O(1); median is O(n log n) for n=30 (~0.01 ms).
// Persisted to disk so a restart doesn't reset us to cold-start fallback on a
// busy morning. Loader is backwards-compatible with the prior plain-number
// format.
const MAX_LATENCY_SAMPLES  = 30;
const MIN_SAMPLES_FOR_EST  = 5;
// Samples older than this are filtered out before the median is taken.
// 12 h is short enough to discard pre-deploy data after a single morning,
// long enough that an idle midday doesn't leave us with too few samples.
const LATENCY_FRESHNESS_MS = parseInt(
  process.env.MONITOR_BOT_LATENCY_FRESHNESS_MS ?? String(12 * 60 * 60 * 1000), 10,
);
const botLatencySamples    = []; // [{ ms, recordedAt }]; newest pushed to end

// ─── Persistence — survives restarts so cold-start doesn't fall back to the
// POS_BOT_EXEC_MS default on a busy morning ──────────────────────────────────
const LATENCY_PERSIST_PATH = process.env.BOT_LATENCY_PERSIST_PATH
  ?? path.join(process.cwd(), 'data', 'bot-latency-samples.json');
const LATENCY_PERSIST_THROTTLE_MS = 5000;
let latencyPersistTimer = null;

function loadBotLatencyFromDisk() {
  try {
    if (!fs.existsSync(LATENCY_PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LATENCY_PERSIST_PATH, 'utf8'));
    if (!Array.isArray(raw)) return;
    // Backwards compat: prior versions stored plain numbers. Treat those as
    // ancient samples (recordedAt=0) so the freshness filter discards them
    // automatically — old pre-warmer cold-login data shouldn't influence
    // post-warmer predictions.
    for (const entry of raw) {
      if (botLatencySamples.length >= MAX_LATENCY_SAMPLES) break;
      const sample = normaliseLatencySample(entry);
      if (sample) botLatencySamples.push(sample);
    }
    if (botLatencySamples.length) {
      console.log(`[Monitor] Restored ${botLatencySamples.length} bot-latency samples from disk`);
    }
  } catch (err) {
    console.warn(`[Monitor] Could not load latency samples (${err.message}) — starting fresh`);
  }
}

/**
 * Normalise a disk entry into the current { ms, recordedAt } shape.
 * Returns null for malformed input. Exported via `_normaliseLatencySample`
 * so tests can verify the back-compat behaviour without touching disk.
 */
function normaliseLatencySample(entry) {
  if (Number.isFinite(entry) && entry > 0) {
    return { ms: entry, recordedAt: 0 }; // legacy plain-number format
  }
  if (entry && Number.isFinite(entry.ms) && entry.ms > 0) {
    return { ms: entry.ms, recordedAt: Number.isFinite(entry.recordedAt) ? entry.recordedAt : 0 };
  }
  return null;
}

function schedulePersistBotLatency() {
  if (latencyPersistTimer) return; // already pending
  latencyPersistTimer = setTimeout(() => {
    latencyPersistTimer = null;
    const tmp = `${LATENCY_PERSIST_PATH}.tmp`;
    try {
      fs.mkdirSync(path.dirname(LATENCY_PERSIST_PATH), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(botLatencySamples));
      fs.renameSync(tmp, LATENCY_PERSIST_PATH); // atomic on POSIX
    } catch (err) {
      console.warn(`[Monitor] Could not persist latency samples: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }, LATENCY_PERSIST_THROTTLE_MS).unref();
}

function recordBotLatency(durationMs, { now = Date.now() } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  botLatencySamples.push({ ms: durationMs, recordedAt: now });
  if (botLatencySamples.length > MAX_LATENCY_SAMPLES) botLatencySamples.shift();
  schedulePersistBotLatency();
}

// Eagerly load on module import so the first poll already has data.
loadBotLatencyFromDisk();

/**
 * Returns the bot execution estimate (ms) used by the drift forecast.
 *   • Fewer than MIN_SAMPLES_FOR_EST FRESH samples → POS_BOT_EXEC_MS fallback
 *   • Otherwise → median of FRESH samples (newer than LATENCY_FRESHNESS_MS old)
 *
 * Median rather than P95 because the post-warmer distribution is tight and
 * symmetric — P95 systematically over-estimates by tracking outliers we no
 * longer have. Freshness window discards pre-warmer cold-login samples that
 * would otherwise hold the estimate artificially high for ~30 bot runs.
 *
 * Pure function in spirit; reads the module-scope sample array but no other
 * state. `now` is injectable so tests can exercise the freshness cutoff
 * without touching the system clock.
 */
function botExecutionEstimateMs({ now = Date.now() } = {}) {
  const cutoff = now - LATENCY_FRESHNESS_MS;
  const fresh  = botLatencySamples
    .filter((s) => s.recordedAt >= cutoff)
    .map((s) => s.ms);
  if (fresh.length < MIN_SAMPLES_FOR_EST) return POS_BOT_EXEC_MS;
  return computeMedian(fresh);
}

// ─── SAN commit-latency tracking (decision → landing stamp) ──────────────────
// Mirrors the bot-latency ring buffer above, but measures a DIFFERENT gap: not
// how long our bot runs, but how long SAN takes to stamp the slot after we fire
// (the storm-day blind spot — see COMMIT_LATENCY_LEAD). Each sample is the
// wall-clock ms from the fire decision (triggerPositionSchedule stamps
// state._posFiredAtMs) to the genuine landing observation. In-memory only: this
// signal is storm-specific and decays fast, so a restart cold-starting to "no
// estimate" (→ 0 ms contribution, i.e. current behaviour) is the correct, safe
// default rather than dragging yesterday's stall forward. Freshness-windowed on
// the same 12 h cutoff as bot latency so a one-off slow morning doesn't haunt
// the estimate for days.
const commitLatencySamples = []; // [{ ms, recordedAt }]; newest pushed to end

function recordCommitLatency(durationMs, { now = Date.now() } = {}) {
  // Guard against garbage: a negative gap (clock skew) or an absurd one (>10 min
  // — a driver who landed hours later via some other path, not this fire) must
  // not poison the median.
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10 * 60 * 1000) return;
  commitLatencySamples.push({ ms: durationMs, recordedAt: now });
  if (commitLatencySamples.length > MAX_LATENCY_SAMPLES) commitLatencySamples.shift();
}

/**
 * Rolling median (ms) of recent SAN commit latencies, or 0 when we have too few
 * fresh samples to trust. 0 makes the horizon contribution a no-op — the safe
 * default, identical to today's behaviour, until real storm data accumulates.
 * `now` injectable for tests.
 */
function commitLatencyEstimateMs({ now = Date.now() } = {}) {
  const cutoff = now - LATENCY_FRESHNESS_MS;
  const fresh  = commitLatencySamples
    .filter((s) => s.recordedAt >= cutoff)
    .map((s) => s.ms);
  if (fresh.length < MIN_SAMPLES_FOR_EST) return 0;
  return computeMedian(fresh);
}

/**
 * Median of a non-empty array of numbers. Sorts a copy so caller's array is
 * not mutated. Exported via `_computeMedian` for unit tests.
 */
function computeMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// EventEmitter — decouples SSE clients from service logic
const emitter = new EventEmitter();
emitter.setMaxListeners(500); // support many concurrent admin browser tabs

// ─── HTML parser (zero dependencies) ─────────────────────────────────────────
/** Normalise a vehicle ID: strip whitespace, uppercase. */
// Strip leading zeros so SAN's padded canonical form ("0142") and our possibly
// unpadded DB value ("142") hash to the same key. Without this the V Holding
// parser and state.vehicleNorm can disagree, leaving a driver permanently
// invisible to polling — observed 2026-06-07 with #142, which triggered a
// 22-minute requeue loop because the bot's WAIT screen showed "Vehicle: 0142"
// while the DB stored "142". (?=\d) keeps a lone "0" intact.
const norm = (id) => String(id ?? '').replace(/\s+/g, '').toUpperCase().replace(/^0+(?=\d)/, '');

/**
 * Parse V Holding HTML into two Maps of normalised vehicleId → row position.
 * Splits on '<tr ' to isolate data rows, finds `font-weight:bold` cells.
 * Position is the number in the first <td> of each row (the queue rank).
 * ~2ms for a 455-row page; scales linearly with page size.
 */
function parseQueue(html) {
  const dispatched     = new Map(); // vehicleId → position number
  const dispatchedDest = new Map(); // vehicleId → 'T1'|'T2'|null  (DEST column)
  const waiting        = new Map(); // vehicleId → position number
  const notAuthorized  = new Set(); // vehicleIds in the red "not authorized" zone

  const chunks = html.split('<tr ');
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.startsWith('class="')) continue;

    const clsEnd  = chunk.indexOf('"', 7);
    const cls     = chunk.slice(7, clsEnd);

    // Position is in the first <td style="">N</td> before the bold vehicle-number <td>
    // The cell is always rendered as <td style="">number</td>
    const firstTdStart = chunk.indexOf('<td style="">');
    const firstTdEnd   = firstTdStart !== -1 ? chunk.indexOf('</td>', firstTdStart) : -1;
    const position     = firstTdEnd !== -1
      ? parseInt(chunk.slice(firstTdStart + 13, firstTdEnd), 10) || null
      : null;

    // Vehicle ID is in the bold <td>
    const boldIdx  = chunk.indexOf('font-weight:bold');
    if (boldIdx === -1) continue;
    const valStart = chunk.indexOf('>', boldIdx) + 1;
    const valEnd   = chunk.indexOf('<', valStart);
    if (valStart <= 0 || valEnd <= valStart) continue;

    const vehicleId = norm(chunk.slice(valStart, valEnd));
    if (!vehicleId) continue;

    if (cls === 'notauthorized')    notAuthorized.add(vehicleId);
    else if (cls === 'holdingdispatched') {
      dispatched.set(vehicleId, position);
      // V Holding shows DEST (T1/T2) only on dispatched rows — the last
      // column of the table. Matching `>T<digit></td>` keeps us anchored
      // to a real cell instead of any incidental "T1" elsewhere in markup.
      const destMatch = chunk.match(/>T(\d+)<\/td>/i);
      dispatchedDest.set(vehicleId, destMatch ? `T${destMatch[1]}` : null);
    }
    else                             waiting.set(vehicleId, position);
  }

  return { dispatched, dispatchedDest, waiting, notAuthorized };
}

/**
 * Parse a terminal (T1 or T2) dispatch list into a Map of normalised vehicleId → position.
 * Terminal pages have no explicit position column — order is arrival time (first row = #1).
 * Row format: <td font-weight:bold>VEHICLE</td><td>TIME</td><td>SR</td><td>TERMINAL</td>
 */
function parseTerminalPage(html) {
  const vehicles = new Map(); // vehicleId → 1-based position
  const chunks = html.split('<tr');
  let position = 0;
  for (let i = 1; i < chunks.length; i++) {
    const chunk    = chunks[i];
    const boldIdx  = chunk.indexOf('font-weight:bold');
    if (boldIdx === -1) continue;
    position++;
    const valStart = chunk.indexOf('>', boldIdx) + 1;
    const valEnd   = chunk.indexOf('<', valStart);
    if (valStart <= 0 || valEnd <= valStart) continue;
    const vehicleId = norm(chunk.slice(valStart, valEnd));
    if (vehicleId) vehicles.set(vehicleId, position);
  }
  return vehicles;
}

// ─── Recent requeue events ring buffer (survives page navigations) ───────────
const MAX_RECENT_EVENTS = 50;
const recentRequeuEvents = [];   // newest first

// ─── Position decision recording ─────────────────────────────────────────────
// Writes one row per driver per day to position_tracking, upserted on every
// decision-state CHANGE (not every poll). For ~10 drivers this is ≤30 writes/day
// total — negligible DB load. The in-memory state.lastPosDecision is the de-dupe
// gate so we don't write the same 'waiting' row 120 times an hour.
//
// Fire-state metrics are passed when transitioning to 'fired' (inside
// triggerPositionSchedule), so a single row captures the lifecycle:
//   waiting → fired → completed (or missed/failed).
function recordPositionDecision(state, decision, reason, metrics = {}) {
  if (state.lastPosDecision === decision) return; // no state change → no write
  state.lastPosDecision = decision;

  PositionTracking.upsertDecision({
    driverId:              state.driverId,
    vehicleNumber:         state.vehicleNumber,
    targetPosition:        metrics.targetPosition,
    maxAcceptablePosition: metrics.maxAcceptablePosition,
    decision,
    decisionReason:        reason,
    queueSizeAtFire:       metrics.queueSize,
    growthRate:            metrics.growthRate,
    estimatedDrift:        metrics.estimatedDrift,
    predictedLanding:      metrics.predictedLanding,
    firedAt:               metrics.firedAt,
    earlyJoinPosition:     metrics.earlyJoinPosition ?? null,
  }).catch((err) => console.error(
    `[PosTracking] upsert failed for #${state.vehicleNumber}: ${err.message}`,
  ));
}

// ─── SSE broadcast ───────────────────────────────────────────────────────────
function broadcast(type, payload) {
  const ts = Date.now();
  if (type === 'requeue_result') {
    recentRequeuEvents.unshift({ type, payload, ts });
    if (recentRequeuEvents.length > MAX_RECENT_EVENTS) recentRequeuEvents.length = MAX_RECENT_EVENTS;
  }
  emitter.emit('event', { type, payload, ts });
}

// ─── State snapshot (safe for JSON / SSE) ────────────────────────────────────
function snap(state) {
  return {
    driverId:          state.driverId,
    driverName:        state.driverName,
    vehicleNumber:     state.vehicleNumber,
    isAuto:            state.isAuto,
    isManual:          manualWatchIds.has(state.driverId),
    state:             state.state,
    hasBeenSeen:       state.hasBeenSeen,
    addedAt:           state.addedAt,
    lastSeenAt:        state.lastSeenAt,
    lastDispatchAt:    state.lastDispatchAt,
    lastGoneAt:        state.lastGoneAt,
    lastRequeuedAt:    state.lastRequeuedAt,
    lastResult:        state.lastResult,
    requeueCount:       state.requeueCount,
    requeueCountToday:  state.requeueCountToday,
    scheduledPosition:  state.scheduledPosition,
    dayPositions:       state.dayPositions,
    positionFiredToday:    state.positionFiredToday,
    inQueueFromCarryover:  state.inQueueFromCarryover,
    currentPosition:    state.currentPosition,   // live position from last poll
    lastPosition:       state.lastPosition,       // position bot placed them at
    atTerminalSince:    state.atTerminalSince,
    terminalSeen:       state.terminalSeen,
    terminalCheckCount: state.terminalCheckCount,
    terminalName:       state.terminalName,
    terminalPosition:   state.terminalPosition,
    earlyJoinDetectedAt: state.earlyJoinDetectedAt, // time of first early-join detection
    earlyJoinAtPosition: state.earlyJoinAtPosition, // queue pos where driver joined early
  };
}

// ─── Re-queue trigger (used by auto-detection & manual run) ──────────────────
async function _runBot(driverId, state, triggerType = 'monitor_requeue', botOpts = {}) {
  // Lazy-require to break circular dependency (monitorService ← schedulerService).
  const { runBotForDriver } = require('./schedulerService');

  const driver = await Driver.findByIdWithCredentials(driverId);
  if (!driver || !driver.is_active) throw new Error('Driver not found or inactive');

  const result = await runBotForDriver(driver, triggerType, botOpts);

  // Record execution time for the rolling estimator used by drift prediction.
  // Only genuine *new* adds belong in this pool — fast paths and failure paths
  // are not representative of the latency the position scheduler needs to plan
  // for, and including them collapses the median:
  //   • alreadyQueued      → bot lands on WAIT screen in 1-2 s without adding;
  //                          dominated the pool on 2026-06-07 (#142 alone fed
  //                          200+ fast samples), driving botEst from ~6 s down
  //                          to 1.5 s and causing the burst's +15 to +26 over-
  //                          shoots.
  //   • !success           → timeouts pin near 60 s; credential fast-fails
  //                          pin near 1 s. Neither represents a real add.
  //   • recoveredFromTimeout → bot did attempt the add, but durationMs is the
  //                          timeout cap, not real work time — also unrepresentative.
  // Per-row PositionTracking duration is still recorded unconditionally — it's
  // a bookkeeping field for the Position Accuracy report, not a calibration signal.
  if (Number.isFinite(result?.durationMs)) {
    //   • viaArmedSession    → a pre-armed fire is a ~1 s click on a parked
    //                          page. Pooling those would drag the COLD-launch
    //                          median (and thus the drift horizon for every
    //                          un-armed fire) far below what a real launch
    //                          costs — the same distortion alreadyQueued
    //                          caused on 2026-06-07, from the other side.
    const representsRealAdd =
      result.success
      && !result.alreadyQueued
      && !result.recoveredFromTimeout
      && !result.viaArmedSession;
    if (representsRealAdd) recordBotLatency(result.durationMs);
    // If this was a position-schedule fire, persist the duration onto the
    // same row that already has the 'fired' decision.
    if (state.pendingTrackingId) {
      PositionTracking.recordBotDuration(state.pendingTrackingId, result.durationMs)
        .catch((err) => console.error('[PosTracking] recordBotDuration error:', err.message));
    }
  }

  state.lastResult  = result;
  state.state       = 'watching';
  // Keep hasBeenSeen=true when the bot succeeded (added or found already in queue).
  // This prevents the position scheduler from firing in the gap between bot
  // completion and the next queue-page fetch — the next poll will confirm in_queue.
  // Only reset to false if the bot actually failed (driver is definitely not in queue).
  state.hasBeenSeen = !!(result?.success);
  if (result?.success && !result?.alreadyQueued) {
    state.requeueCount++;
    state.requeueCountToday++;
    // A real add proves the driver was NOT in queue — clear any runaway guard.
    state.consecutiveAlreadyQueued = 0;
    state.requeueBlockedReason     = null;
  } else if (result?.success && result?.alreadyQueued && !result?.recoveredFromTimeout) {
    // Bot kept finding the driver already in queue while our poll never sees
    // them — almost certainly a key mismatch (e.g. SAN canonical "0142" vs DB
    // "142"). Bump the consecutive counter; the requeue gate below uses it to
    // stop hammering SAN after MAX_CONSECUTIVE_ALREADY_QUEUED hits.
    state.consecutiveAlreadyQueued = (state.consecutiveAlreadyQueued || 0) + 1;
  }
  if (result?.position) state.lastPosition = result.position;

  // Record actual_position straight from the bot result rather than waiting
  // for the next poll to see the driver in V Holding. On a busy morning SAN
  // can dispatch a driver out of waiting in under 2 s — faster than the next
  // poll tick — leaving the position_tracking row stuck at decision='fired'
  // forever (the "pending" state in the admin UI). The bot's result.position
  // is SAN-authoritative for the position assigned right after add-to-queue.
  //
  // Critical: a result with alreadyQueued=true means the bot landed on SAN's
  // WAIT screen without adding anyone — the position is whoever else queued
  // the driver (carryover, monitor auto-requeue, driver self-add). Writing
  // that as the position-schedule actual feeds garbage into medianRecentError,
  // which is how bias correction reached −14 on 2026-05-27 and pushed
  // legitimate fires past maxAcceptable. We still write on the
  // recoveredFromTimeout path: there the bot DID attempt the add — only the
  // response timed out — and the position came from a fresh V Holding fetch,
  // not a stale WAIT screen.
  const safeToRecord =
    result?.success
    && Number.isFinite(result.position)
    && (!result.alreadyQueued || result.recoveredFromTimeout);

  if (state.pendingTrackingId && safeToRecord) {
    const trackingId = state.pendingTrackingId;
    state.pendingTrackingId = null;
    // Freeze the landing on the watch state. The queue position only DECAYS
    // after landing (drivers ahead get dispatched), so anything derived from
    // state.currentPosition later reports a phantom undershoot — the admin
    // borrowed table showed #4004 as ✗ −19 when the real landing was −6.
    state.landedPositionToday = result.position;
    recordFleetLanding(result.position); // feed the true-tail probe (genuine join only)
    // SAN commit latency: decision → this genuine landing stamp. Only for
    // position fires (triggerPositionSchedule set _posFiredAtMs); auto-requeue
    // landings have it unset and are skipped. Cleared so a later landing on this
    // same state can't reuse a stale fire time.
    if (state._posFiredAtMs) {
      const commitMs = Date.now() - state._posFiredAtMs;
      // Decompose the latency into OUR side (decision → click dispatched: claim
      // + browser event-loop serialization) vs SAN/observe (dispatched → slot
      // stamped: network + SAN processing + V-Holding display tick). This is the
      // go/no-go for the parallel-fire lever: if `our` dominates on storm ticks
      // and scales with `inflight`, the latency is ours to cut; if `san` does,
      // no client-side fire path can help. dispatchedAtMs is unset on the cold/
      // HTTP paths, so guard it.
      let split = '';
      if (Number.isFinite(result.dispatchedAtMs)) {
        const ourMs = result.dispatchedAtMs - state._posFiredAtMs;
        const sanMs = Date.now() - result.dispatchedAtMs;
        split = ` [our ${(ourMs / 1000).toFixed(1)}s + san/obs ${(sanMs / 1000).toFixed(1)}s`
          + `, inflight ${result.inFlightAtDispatch ?? '?'}]`;
      }
      state._posFiredAtMs = null;
      recordCommitLatency(commitMs);
      console.log(`[Pos] ⏱ #${state.vehicleNumber} SAN commit latency ${(commitMs / 1000).toFixed(1)}s${split} ` +
        `(median ${(commitLatencyEstimateMs() / 1000).toFixed(1)}s over ${commitLatencySamples.length} fires)`);
    }
    PositionTracking.updateActualPosition(trackingId, result.position)
      .then(() => console.log(`[PosTracking] #${state.vehicleNumber} landed at ${result.position} (from bot result)`))
      .catch((err) => console.error('[PosTracking] Failed to update actual position from bot result:', err.message));
  } else if (state.pendingTrackingId && result?.alreadyQueued && !result.recoveredFromTimeout) {
    // Drop pendingTrackingId so the next poll's V-Holding observation doesn't
    // attach a (potentially also stale) actual_position to this row. Relabel the
    // row 'already_queued' (without writing actual_position — that would poison
    // bias) so the report shows the real cause instead of a stuck "pending".
    const aqTrackingId = state.pendingTrackingId;
    state.pendingTrackingId = null;
    state._posFiredAtMs = null; // this fire didn't genuinely land — no commit sample
    PositionTracking.markAlreadyQueued(aqTrackingId)
      .catch((err) => console.error('[PosTracking] markAlreadyQueued error:', err.message));
    console.log(`[PosTracking] #${state.vehicleNumber} → bot found already in queue (pos ${result.position}) — labelled already_queued, NOT recording actual (avoids bias contamination)`);
  } else if (state.pendingTrackingId && !result?.success) {
    // Bot returned a non-success result without throwing. This is the path for
    // fast-fail outcomes: credential lockout, "Vehicle not available for
    // registration", "vehicle not found", etc. Without clearing the handle
    // here, the next poll observes the driver in V Holding (possibly from a
    // completely unrelated channel — manual fire, auto-requeue, self-add) and
    // writes that position as the actual. That's the +116 #631 contamination
    // we observed on 2026-05-29.
    //
    // We also mark the row as failed so the Position Accuracy table shows the
    // outcome clearly rather than leaving it in 'pending' forever. The 'fired'
    // decision stays in place for analytics; markFailed just appends the
    // failure context.
    const failedTrackingId = state.pendingTrackingId;
    state.pendingTrackingId = null;
    state._posFiredAtMs = null; // failed fire — no commit sample
    const reason = result?.error || result?.message || 'unknown bot failure';
    PositionTracking.markFailed(failedTrackingId, reason)
      .catch((err) => console.error('[PosTracking] markFailed (non-success) error:', err.message));
    console.log(`[PosTracking] #${state.vehicleNumber} → bot returned failure (${reason}) — row marked failed, NOT recording actual_position`);
  }

  broadcast('requeue_result', {
    driverId,
    driverName:    state.driverName,
    vehicleNumber: state.vehicleNumber,
    result,
    isAuto:        state.isAuto,
  });
  broadcast('driver_state', { driverId, state: snap(state) });

  const tag       = triggerType === 'position_schedule' ? '[Pos]' : '[Monitor]';
  const logSuffix = result?.success ? `pos #${result.position}` : `failed — ${result?.error || result?.message || 'unknown'}`;
  console.log(`${tag} ✓ #${state.vehicleNumber} → ${logSuffix}`);
}

// Record one terminal-trip metric (dwell + detection lag) at the moment we
// auto-requeue a driver after a terminal trip. Best-effort and non-blocking —
// a DB error must never stop the requeue. Resets the per-trip capture fields.
function recordTerminalMetric(state, requeuePath) {
  // Wrapped whole-body: this runs in the hot poll loop right before the requeue
  // fires, so it must never throw (e.g. if the code deploys before the migration
  // runs). Any failure is logged and swallowed.
  try {
    const atSince = state.atTerminalSince;
    if (!atSince) return; // not a terminal trip — nothing to record
    const now = new Date();
    const terminal = state.terminalName || state.dispatchTerminal || null;
    const dwellSeconds = Math.max(0, Math.round((now - atSince) / 1000));
    const detectionLagSeconds = state.terminalLastSeenAt
      ? Math.max(0, Math.round((now - state.terminalLastSeenAt) / 1000))
      : null;

    TerminalMetric.record({
      driverId:            state.driverId,
      vehicleNumber:       state.vehicleNumber,
      terminal,
      requeuePath,
      atTerminalSince:     atSince,
      terminalLastSeenAt:  state.terminalLastSeenAt || null,
      requeuedAt:          now,
      dwellSeconds,
      detectionLagSeconds,
      terminalPosition:    state.terminalPosition ?? null,
    }).catch((err) => console.error(`[TerminalMetric] record failed for #${state.vehicleNumber}: ${err.message}`));

    // Fresh slate for the next trip.
    state.dispatchTerminal   = null;
    state.terminalLastSeenAt = null;
  } catch (err) {
    console.error(`[TerminalMetric] skipped for #${state.vehicleNumber}: ${err.message}`);
  }
}

async function triggerRequeue(driverId, state, { delayMs = 0 } = {}) {
  state.state          = 'requeuing';
  state.lastRequeuedAt = new Date();
  broadcast('driver_state',      { driverId, state: snap(state) });
  broadcast('requeue_triggered', { driverId, vehicleNumber: state.vehicleNumber });

  const delayNote = delayMs > 0 ? ` — bot queued in ${delayMs / 1000}s` : '';
  console.log(`[Monitor] ⚡ Re-queue scheduled for #${state.vehicleNumber}${delayNote} (queue: ${jobQueue.activeCount} active, ${jobQueue.pendingCount} pending)`);

  const enqueue = () => {
    console.log(`[Monitor] ▶ #${state.vehicleNumber} — queuing bot now`);
    jobQueue.enqueue(() =>
      _runBot(driverId, state).catch((err) => {
        state.state      = 'watching';
        state.hasBeenSeen = false;
        state.lastResult  = { success: false, error: err.message };

        broadcast('requeue_result', {
          driverId,
          driverName:    state.driverName,
          vehicleNumber: state.vehicleNumber,
          result:        { success: false, error: err.message },
          isAuto:        state.isAuto,
        });
        broadcast('driver_state', { driverId, state: snap(state) });
        console.error(`[Monitor] ✗ Re-queue failed #${state.vehicleNumber}: ${err.message}`);
      }),
    );
  };

  if (delayMs > 0) {
    console.log(`[Monitor] ⏳ #${state.vehicleNumber} — waiting ${delayMs / 1000}s for SAN server to settle…`);
    setTimeout(enqueue, delayMs);
  } else {
    enqueue();
  }
}

// Debounce step for the carryover-cleared signal. Pure + exported for tests.
// Given the count of consecutive polls a carryover driver has been absent from
// V Holding, returns whether to clear the carryover flag now and the next count.
// Clears only once absences reach the threshold — so a single flickered poll
// during SAN's midnight refresh can't prematurely clear a still-queued leftover.
function carryoverClearStep(absentPolls, threshold = CARRYOVER_CLEAR_POLLS) {
  const next = (absentPolls || 0) + 1;
  return next >= threshold ? { clear: true, absentPolls: 0 } : { clear: false, absentPolls: next };
}

// ─── Overnight carryover cleanup ──────────────────────────────────────────────
// Best-effort attempt to pull one leftover out of yesterday's V Holding at the
// daily reset (see CARRYOVER_REMOVE_ENABLED — DISABLED by default).
//
// CRITICAL: this NEVER mutates the carryover protection flags. The earlier
// version cleared inQueueFromCarryover/hasBeenSeen on the bot's self-reported
// "success", but that success doesn't mean the driver actually left — SAN's
// rollover re-lists them within seconds, after which the next poll re-flagged
// hasBeenSeen=true and the scheduler skipped them as "already in queue" (the
// 2026-06-15 fleet-wide outage). The ONLY thing that clears carryover is the
// debounced poll confirmation (carryoverClearStep) once the driver is genuinely
// and repeatedly absent from V Holding. So even a "successful" remove here
// leaves protection fully intact — the worst case is a wasted bot run.
async function removeCarryoverLeftover(driverId, vehicleNumber) {
  try {
    const driver = await Driver.findByIdWithCredentials(driverId);
    if (!driver || driver.is_active === false || !driver.san_username || !driver.san_password) return;

    const { runRemoveBotForDriver } = require('./schedulerService');
    const result = await runRemoveBotForDriver(driver, 'carryover_cleanup');

    if (result?.success) {
      console.log(`[Monitor] carryover cleanup for #${vehicleNumber} sent remove (protection stays until SAN confirms the driver is gone)`);
    } else {
      console.warn(`[Monitor] carryover cleanup for #${vehicleNumber} did not remove (${result?.error || 'unknown'}) — leaving in queue, SAN will clear it`);
    }
  } catch (err) {
    console.warn(`[Monitor] carryover cleanup for #${vehicleNumber} errored: ${err.message} — leaving in queue, SAN will clear it`);
  }
}

// ─── Red-zone (not_authorized) auto-remove ────────────────────────────────────
// Pure throttle decision, kept separate so it can be unit-tested. Returns whether
// a remove may fire for this cab right now, given its per-day attempt count, the
// last attempt time, and whether a remove is already in flight. See
// REDZONE_* config above for the guard rationale (midnight churn containment).
function _redzoneRemoveDecision(state, nowMs, {
  cooldownMs = REDZONE_REMOVE_COOLDOWN_MS,
  maxPerDay  = REDZONE_REMOVE_MAX_PER_DAY,
} = {}) {
  if (state.redzoneRemoveInFlight)                         return { allow: false, reason: 'in_flight' };
  if ((state.redzoneRemoveCountToday ?? 0) >= maxPerDay)   return { allow: false, reason: 'daily_cap' };
  const last = state.redzoneRemoveLastAttemptMs ?? 0;
  if (nowMs - last < cooldownMs)                           return { allow: false, reason: 'cooldown' };
  return { allow: true };
}

// Fire the remove bot for a cab sitting in SAN's red "not authorized" zone.
// Modelled on removeCarryoverLeftover: it NEVER mutates carryover/hasBeenSeen
// flags, so even a self-reported "success" can't strand the driver — the only
// authority on "left the red zone" is the next poll re-parsing V Holding (which
// flips them out of not_authorized and triggers the verification log below).
async function autoRemoveNotAuthorized(driverId, vehicleNumber) {
  const pre = watches.get(driverId);
  if (pre) pre.redzoneRemoveInFlight = true;
  try {
    const driver = await Driver.findByIdWithCredentials(driverId);
    if (!driver || driver.is_active === false || !driver.san_username || !driver.san_password) return;

    const { runRemoveBotForDriver } = require('./schedulerService');
    const result = await runRemoveBotForDriver(driver, 'redzone_auto_remove');

    if (result?.success) {
      console.log(`[Monitor] #${vehicleNumber} — red-zone auto-remove sent (verifying against V Holding next poll)`);
    } else if (result?.dispatched) {
      console.log(`[Monitor] #${vehicleNumber} — red-zone auto-remove skipped: SAN says dispatched, not removable`);
    } else {
      console.warn(`[Monitor] #${vehicleNumber} — red-zone auto-remove did not remove (${result?.error || result?.message || 'unknown'}) — SAN may re-clear it`);
    }
  } catch (err) {
    console.warn(`[Monitor] #${vehicleNumber} — red-zone auto-remove errored: ${err.message}`);
  } finally {
    const s = watches.get(driverId);
    if (s) s.redzoneRemoveInFlight = false;
  }
}

// ─── Forced drop + re-arm of one stuck overnight leftover (position-window open) ─
// Removes a driver SAN failed to purge overnight, then — ONLY on a confirmed
// removal — arms them to fire fresh at today's target. See CARRYOVER_DROP_ENABLED.
//
// The flag handling is deliberately asymmetric:
//   • Confirmed gone  → clear inQueueFromCarryover + hasBeenSeen + positionFired
//     Today so the position scheduler stops waiting and fires at target. We KEEP
//     wasCarryoverToday=true as a safety net: if SAN unexpectedly re-lists the
//     driver before they fire, the poll-loop re-protect path holds them instead
//     of mislabelling them "already in queue". It's cleared naturally on the fire.
//   • Not confirmed / dispatched / error → touch NOTHING. The passive machinery
//     (debounced clear + re-protect) keeps protecting the driver as it does today.
async function dropAndArmLeftover(driverId, vehicleNumber) {
  const pre = watches.get(driverId);
  // Only act on a driver we still believe is a leftover sitting in V Holding.
  if (!pre || !pre.inQueueFromCarryover || pre.state !== 'in_queue') return;

  try {
    const driver = await Driver.findByIdWithCredentials(driverId);
    if (!driver || driver.is_active === false || !driver.san_username || !driver.san_password) return;

    const { runRemoveBotForDriver } = require('./schedulerService');
    const result = await runRemoveBotForDriver(driver, 'carryover_drop');

    // Re-fetch — state may have changed (dispatch, manual action) while the bot ran.
    const s = watches.get(driverId);
    if (!s) return;

    if (result?.success) {
      s.inQueueFromCarryover = false;
      s.hasBeenSeen          = false;
      s.positionFiredToday   = false;
      s.carryoverAbsentPolls = 0;
      if (s.state !== 'requeuing') s.state = 'watching';
      console.log(`[Monitor] #${vehicleNumber} — forced overnight drop CONFIRMED, armed to fire fresh at target`);
      broadcast('driver_state', { driverId, state: snap(s) });
    } else if (result?.dispatched) {
      console.log(`[Monitor] #${vehicleNumber} — forced drop skipped: driver is dispatched (on a trip), not a stuck leftover`);
    } else {
      console.warn(`[Monitor] #${vehicleNumber} — forced drop NOT confirmed (${result?.error || 'unknown'}) — protection left intact, SAN will clear it`);
    }
  } catch (err) {
    console.warn(`[Monitor] #${vehicleNumber} — forced drop errored: ${err.message} — protection left intact`);
  }
}

// Enqueue a forced drop for every leftover SAN didn't purge overnight. Called
// once per day right after the 3 AM position-window arm, when inQueueFromCarryover
// has just been (re)computed for every watched driver. Fire-and-forget via the
// concurrency-capped jobQueue so it never blocks the poll loop. Returns how many
// drops were enqueued. No-op (and no bot runs) when CARRYOVER_DROP_ENABLED=false.
function dropAndArmCarryoverLeftovers(dayKey = todayPT) {
  if (!CARRYOVER_DROP_ENABLED) return 0;
  // Only drop leftovers we can actually RE-ARM — i.e. drivers with a position
  // target to fire at. A pure manual driver (no schedule) has no target, so a
  // drop would just evict them with no re-add; leaving them in the draining
  // overnight queue is better for them. They're handled by the passive machinery.
  const leftovers = [...watches.values()].filter(
    (s) => s.inQueueFromCarryover && s.state === 'in_queue' && (s.scheduledPosition || s.dayPositions),
  );
  if (!leftovers.length) return 0;
  console.log(`[Monitor] Position window — forcing drop of ${leftovers.length} stuck overnight leftover(s) SAN didn't purge (day ${dayKey})`);
  for (const s of leftovers) {
    jobQueue.enqueue(() => dropAndArmLeftover(s.driverId, s.vehicleNumber)).catch(() => {});
  }
  return leftovers.length;
}

// ─── Position-schedule trigger ───────────────────────────────────────────────
// Fires when the live queue waiting count reaches the driver's target - 3.
// No delay before the bot — unlike auto-requeue this is an initial add, not a
// re-add after dispatch, so the SAN server is always ready to accept it.
// positionFiredToday is set BEFORE enqueuing so concurrent polls cannot
// double-trigger the same driver.
async function triggerPositionSchedule(driverId, state, effectivePosition, {
  growthRate           = 0,
  estimatedDrift       = 0,
  predictedLanding     = null,
  maxAcceptablePosition = null,
} = {}) {
  state.state          = 'requeuing';
  state.lastRequeuedAt = new Date();
  broadcast('driver_state',      { driverId, state: snap(state) });
  broadcast('requeue_triggered', { driverId, vehicleNumber: state.vehicleNumber });

  const queueSizeAtFire = state._lastQueueSize ?? 0;
  // Stamp the fire-decision instant so the genuine-landing handler can measure
  // SAN's commit latency (click → slot stamped). Position fires only — cleared
  // when consumed so an unrelated later landing can't reuse a stale timestamp.
  state._posFiredAtMs = Date.now();
  console.log(`[Pos] 📍 Bot queued for #${state.vehicleNumber} — target: ${effectivePosition}, queue now: ${queueSizeAtFire}`);

  // Upsert the 'fired' decision — replaces any prior 'waiting' record for today.
  // Non-blocking; we capture pendingTrackingId so the bot result / actual landing
  // can be filled in on the same row later.
  PositionTracking.upsertDecision({
    driverId,
    vehicleNumber:         state.vehicleNumber,
    targetPosition:        effectivePosition,
    maxAcceptablePosition,
    decision:              'fired',
    decisionReason:        'inside_fire_window',
    queueSizeAtFire,
    growthRate,
    estimatedDrift,
    predictedLanding,
    firedAt:               new Date(),
  }).then((trackingId) => {
    state.pendingTrackingId = trackingId;
    state.lastPosDecision   = 'fired';
  }).catch((err) => console.error('[PosTracking] Failed to upsert fired row:', err.message));

  const runFire = (armedShot = null) =>
    _runBot(driverId, state, 'position_schedule', {
      armedShot,
      // A claimed fire bypassed the jobQueue, so its cold fallback must
      // re-enter it — an uncapped fallback launch is how Jun 12's six
      // simultaneous Chromiums produced the +28…+48 landings. Cold-from-the-
      // start fires get no gate: they already run inside a jobQueue slot,
      // and nesting enqueue inside a held slot would deadlock at concurrency.
      coldGate: armedShot ? (fn) => jobQueue.enqueue(fn) : null,
    }).catch((err) => {
      // Idempotent no-op when the shot was already consumed — this covers
      // _runBot throwing before runBotForDriver takes ownership.
      disposeClaimedFireSession(armedShot, 'position fire failed before firing');
      state.state      = 'watching';
      state.hasBeenSeen = false;
      state.lastResult  = { success: false, error: err.message };

      // Persist the failure so the report shows it. Clearing pendingTrackingId
      // is critical: without it, the next poll's V Holding observation would
      // overwrite this failed row's actual_position (the driver may still be
      // in queue from an earlier event), masking the failure in the report.
      if (state.pendingTrackingId) {
        const failedTrackingId = state.pendingTrackingId;
        state.pendingTrackingId = null;
        PositionTracking.markFailed(failedTrackingId, err.message)
          .catch((e) => console.error('[PosTracking] markFailed error:', e.message));
        state.lastPosDecision = 'failed';
      }

      broadcast('requeue_result', {
        driverId,
        driverName:    state.driverName,
        vehicleNumber: state.vehicleNumber,
        result:        { success: false, error: err.message },
        isAuto:        state.isAuto,
      });
      broadcast('driver_state', { driverId, state: snap(state) });
      console.error(`[Monitor] ✗ Position trigger failed #${state.vehicleNumber}: ${err.message}`);
    });

  // Claim the armed session SYNCHRONOUSLY, before any await. The fire
  // decision just set positionFiredToday=true, which drops this driver from
  // the pre-arm wanted set — so THIS SAME TICK's syncFireSessions would
  // disarm the parked page while the fire is still doing its DB roundtrips
  // (Driver.findByIdWithCredentials + Log.create take longer than the loop
  // takes to reach the sync call). Jun 11–12 production: all 30 fires logged
  // "armed session ready" and then lost the session to "no longer scheduled"
  // one tick later — zero armed shots ever happened. Claiming detaches the
  // record from the reconciler's map, so it cannot be disarmed; the fire path
  // owns it from here and disposes it on every outcome.
  const armedShot = claimArmedFireSession(driverId);

  // A claimed fire is a click on an already-open page — no Chromium launch —
  // so routing it through the launch-capped jobQueue would only re-introduce
  // the serialization the arming exists to remove (Jun 09: five simultaneous
  // fires at concurrency 3 → the second batch waited ~3.5 s and landed +25
  // past the first). Claimed → run immediately; cold → queue as before.
  if (armedShot) {
    console.log(`[Pos] ⚡ #${state.vehicleNumber} — armed session claimed, firing now`);
    runFire(armedShot);
  } else {
    jobQueue.enqueue(() => runFire(null));
  }
}

/**
 * Synchronously claim botService's parked, ready-to-click page for this
 * driver (null when none). Lazy require: botService pulls in Playwright —
 * tests that exercise the scheduler decision logic shouldn't pay that cost
 * (or need that mock) unless they opt in. Failure-safe: any error means "not
 * armed" and the cold path (jobQueue → full bot run) handles the fire exactly
 * as before pre-arming.
 */
function claimArmedFireSession(driverId) {
  if (!PREARM_ENABLED) return null;
  try {
    return require('./botService').claimArmedSession(driverId);
  } catch {
    return null;
  }
}

/**
 * Non-consuming peek: does this driver have a parked, ready-to-click session
 * right now? Used by the place-anyway fallback to decide warm (fire the open
 * click) vs. skip, WITHOUT claiming the session (claimArmedFireSession removes
 * it from the map). Failure-safe: any error means "not armed".
 */
function hasArmedFireSession(driverId) {
  if (!PREARM_ENABLED) return false;
  try {
    return require('./botService').hasArmedFireSession(driverId);
  } catch {
    return false;
  }
}

/**
 * Route a `place_anyway` decision given the driver's live armed state. Pure —
 * no I/O — so the warm/cold policy is unit-testable without botService.
 *
 *   warm mode (PLACE_ANYWAY_COLD_OK=false):
 *     armed   → fire warm (claim the still-open single-click session)
 *     unarmed → do NOT fire; fall back to recording the miss. A cold fire on a
 *               guaranteed-overshoot driver mid-leap lands ~+160 s late and
 *               inflates everyone else's drift, so warm mode never does it.
 *   cold mode (PLACE_ANYWAY_COLD_OK=true):
 *     armed   → fire warm;  unarmed → fire cold (launch() cold-paths it).
 *
 * Returns { fire:true, warm } to push to the fire batch, or { fire:false, miss }
 * to record decision.fallbackFrom (the original miss) unchanged.
 */
function resolvePlaceAnyway(decision, armed) {
  if (armed)              return { fire: true,  warm: true  };
  if (PLACE_ANYWAY_COLD_OK) return { fire: true,  warm: false };
  return { fire: false, miss: decision.fallbackFrom };
}

/** Failure-path disposal for a claimed session (idempotent, never throws). */
function disposeClaimedFireSession(session, reason) {
  if (!session) return;
  try {
    require('./botService').disposeClaimedSession(session, reason).catch(() => {});
  } catch { /* botService unavailable — context dies with the shared browser */ }
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────
// Each attempt gets a fresh AbortSignal so a timed-out attempt doesn't cancel
// the next one. Waits RETRY_DELAYS[attempt] ms before each retry.
//
// MONITOR_POLL_CACHE_BUST=1: append a unique query param + no-cache headers to
// every poll fetch. The spacezone page's waiting count only CHANGES every ~5 s
// even at 1 s polling — if that step is an intermediary/output cache keyed by
// URL (rather than SAN's own render cadence), busting it gives the scheduler
// 1 s-granularity queue truth and shrinks the burst observation hole for free.
// Read-side only; default off so prod behaviour is unchanged until compared.
const POLL_CACHE_BUST = process.env.MONITOR_POLL_CACHE_BUST === '1';
async function fetchPage(url) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    // Re-checked per attempt so the breaker can trip mid-retry and the very
    // next attempt goes direct. The dispatcher is undefined when proxy is
    // disabled / unconfigured / breaker open.
    const dispatcher    = currentPollDispatcher();
    const proxyAttempt  = dispatcher !== undefined;

    try {
      const fetchUrl = POLL_CACHE_BUST
        ? `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`
        : url;
      const res = await ufetch(fetchUrl, {
        headers:    {
          'User-Agent': UA,
          Accept:       'text/html,application/xhtml+xml',
          ...(POLL_CACHE_BUST ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {}),
        },
        signal:     AbortSignal.timeout(FETCH_TIMEOUT),
        dispatcher,
      });
      if (!res.ok) {
        // Treat 407 Proxy Auth Required as a proxy failure; everything else
        // (SAN 5xx, etc.) is a SAN-side problem and shouldn't trip the breaker.
        const httpErr = new Error(`HTTP ${res.status}`);
        if (proxyAttempt && res.status === 407) proxyHealth.reportFailure('http 407');
        throw httpErr;
      }
      if (proxyAttempt) proxyHealth.reportSuccess();
      if (attempt > 0) console.log(`[Monitor] Fetch succeeded on attempt ${attempt + 1} (${url})`);
      return res;
    } catch (err) {
      lastErr = err;
      if (proxyAttempt && looksLikeProxyFailure(err)) {
        proxyHealth.reportFailure(err.message || 'fetch failed');
      }
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
      if (attempt < RETRY_COUNT - 1) {
        const via = proxyAttempt ? 'via proxy' : 'direct';
        console.warn(`[Monitor] Fetch attempt ${attempt + 1}/${RETRY_COUNT} (${via}) failed (${url}): ${err.message} — retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Position-scheduler decision function ───────────────────────────────────
// Pure function — no side effects, no I/O. Returns a decision object the caller
// applies. Centralising the logic here makes it easy to unit-test and ensures
// the log line, DB write, and bot fire all see the same metrics.
//
// Decision shape:
//   { action: 'skip_no_target'      }                                  // no DB write
//   { action: 'skip_already_fired'  , logLine }                        // no DB write
//   { action: 'skip_locked_out'     , reason, logLine, metrics }       // creds bad
//   { action: 'skip_bot_inflight'   , reason, logLine, metrics }
//   { action: 'skip_already_seen'   , reason, logLine, metrics }
//   { action: 'fire'                , reason, logLine, fireOpts, ... } // sets positionFiredToday
//   { action: 'wait'                , reason, logLine, metrics, secondsUntilFire }
//   { action: 'missed_impossible'   , reason, logLine, metrics }       // queue already past max
//
// `isLockedOut` is injected via ctx so this function stays pure and unit-testable
// without depending on the credentialLockoutService singleton.
function evaluatePositionScheduler(state, ctx) {
  const {
    waitingCount,
    effectiveGrowthRate,
    estimatedDrift,
    biasCorrection,
    horizonSeconds,
    botExecMs,
    todayDayKey,
    botSamplesCount,
    queueShrinkageDetected = false,
    isLockedOut             = () => false,
    inBurstWindow           = false,
    maxLeadPositions        = POS_MAX_LEAD,
    onsetActive             = false,
    onsetCap                = ONSET_CAP, // dynamic calm-guard cap — see onsetCapNow
    growthLeadEnabled       = GROWTH_LEAD_ENABLED,
    onsetSafeHorizon        = ONSET_SAFE_HORIZON,
    onsetMidHorizon         = ONSET_MID_HORIZON,
    onsetMidCap             = ONSET_MID_CAP,
    observedVelocity        = 0,
    currentInflight         = 0,
    ladderWindowOpen        = false,
    seedWindowOpen          = false,
    seedPromote             = false, // set only by runLadderSeedPass — widens the ladder gap to LADDER_SEED_GAP
    seedRise                = 0,     // net queue rise over SEED_RISE_WINDOW_S — the growth signal the seed depth scales with
    proactiveOpen           = false, // MONITOR_LADDER_PROACTIVE window is open (burst window + past _AFTER)
    proactiveFrac           = 0,     // 0..1 ramp from _AFTER (shallow) to _PEAK (full budget)
  } = ctx;

  // Inactive drivers have no business being scheduled. isActive is synced to the
  // in-memory state immediately on deactivation and every AUTO_REFRESH_MS — but
  // during the brief gap before refresh we still want to block the bot from
  // running. Treat the same as skip_no_target so positionFiredToday is set and
  // the defer guard releases (preventing an eternal hold on terminal-cleared events).
  if (state.isActive === false) return { action: 'skip_no_target' };

  // Resolve today's effective position — skip drivers with no target today
  let effectivePosition = state.scheduledPosition;
  if (state.dayPositions) {
    try {
      const dp = JSON.parse(state.dayPositions);
      effectivePosition = dp[todayDayKey] ?? null;
    } catch { effectivePosition = null; }
  }
  if (!effectivePosition) return { action: 'skip_no_target' };

  // Tolerance ceiling — driver-configured or default (target + 20)
  const maxAcceptable = Number.isInteger(state.maxAcceptablePosition)
    ? state.maxAcceptablePosition
    : effectivePosition + 40; // widened from +20: the corrected drift formula keeps
                               // projections accurate for typical bursts (~1–2/s), but
                               // extreme spikes (4–5/s) can still temporarily push drift
                               // past the old +20 ceiling and block drivers with viable
                               // windows (e.g. Jun 04 #354: proj=138 > max=131, landed
                               // at +7 when fired). Drivers who want tighter control can
                               // set maxAcceptablePosition explicitly in their profile.

  const baseMetrics = { targetPosition: effectivePosition, maxAcceptablePosition: maxAcceptable };
  const veh         = `#${state.vehicleNumber}`;

  // ─── Early skip checks ────────────────────────────────────────────────────
  if (state.positionFiredToday) {
    return {
      action:  'skip_already_fired',
      logLine: `[Pos] ${veh} — already fired today (target: ${effectivePosition}), skipping`,
      metrics: baseMetrics, // target feeds the undershoot-rescue detector
    };
  }
  // Credentials confirmed bad earlier (warmer or a prior bot run). Skip the
  // fire so we don't burn a slot on a guaranteed failure — and so we don't
  // create a "fired" position_tracking row that the next V Holding observation
  // could contaminate (the +116 #631 path from 2026-05-29). NOT marking
  // positionFiredToday so that if the admin updates the SAN password mid-day
  // and clears the lockout, the scheduler picks them up again automatically.
  if (isLockedOut(state.driverId)) {
    return {
      action:  'skip_locked_out',
      reason:  'credentials_locked_out',
      logLine: `[Pos] ${veh} — credentials locked out, skipping (driver must update SAN password)`,
      metrics: baseMetrics,
    };
  }
  if (state.state === 'requeuing') {
    return {
      action:  'skip_bot_inflight',
      reason:  'bot_currently_running',
      logLine: `[Pos] ${veh} — bot in-flight, skipping`,
      metrics: baseMetrics,
    };
  }
  // Carryover from yesterday: still in V Holding at midnight rollover. SAN
  // empties V Holding overnight (logs show queue=0 by ~02:00 PT), so we wait
  // for the purge rather than firing now — which would land on SAN's "Already
  // in queue" WAIT screen and record yesterday's position as today's actual.
  // The state machine clears inQueueFromCarryover the first poll the driver
  // is no longer in V Holding, after which this branch stops matching.
  if (state.inQueueFromCarryover) {
    return {
      action:           'wait',
      reason:           'awaiting_overnight_purge',
      secondsUntilFire: Infinity, // SAN's purge time isn't predictable
      logLine:          `[Pos] ${veh} — ⏸ carryover from yesterday (waiting for SAN to drop, queue: ${waitingCount})`,
      metrics:          baseMetrics,
    };
  }
  if (state.hasBeenSeen) {
    return {
      action:  'skip_already_seen',
      reason:  'driver_already_in_queue_today',
      logLine: `[Pos] ${veh} — already in queue today, skipping`,
      metrics: baseMetrics,
    };
  }

  // ─── Already past max — abort, the train has left the station ────────────
  // If the queue is ALREADY beyond maxAcceptable at fire-decision time, there
  // is no possible bot completion time where the driver lands at-or-better
  // than max. Firing anyway just wastes a bot slot and produces a record like
  // "target 350, actual 481" which is meaningless data. Mark the row as
  // missed_impossible so the admin UI shows what happened.
  if (waitingCount > maxAcceptable) {
    const missDecision = {
      action:  'missed_impossible',
      reason:  'queue_already_past_max',
      logLine: `[Pos] ${veh} — ✗ queue ${waitingCount} > max ${maxAcceptable} (target ${effectivePosition}) — too late, skipping`,
      metrics: { ...baseMetrics, queueSize: waitingCount },
    };
    if (!PLACE_ANYWAY_ON) return missDecision;
    return {
      action:            'place_anyway',
      reason:            'queue_already_past_max',
      effectivePosition,
      maxAcceptable,
      fallbackFrom:      missDecision, // caller records this if it declines to fire (warm-only + unarmed)
      logLine: `[Pos] ${veh} — ⚠ place-anyway: queue ${waitingCount} > max ${maxAcceptable} (target ${effectivePosition}) — firing best-effort to avoid a miss`,
      fireOpts: {
        growthRate:            effectiveGrowthRate,
        estimatedDrift,
        predictedLanding:      waitingCount + 1, // floor — SAN appends at the tail
        maxAcceptablePosition: maxAcceptable,
        bestEffort:            true,
      },
      metrics: {
        ...baseMetrics,
        queueSize:        waitingCount,
        growthRate:       effectiveGrowthRate,
        estimatedDrift,
        predictedLanding: waitingCount + 1,
      },
    };
  }

  // ─── Dispatch-purge guard ────────────────────────────────────────────────
  // If the queue is actively shrinking (a dispatch batch just opened — common
  // at the 5 AM operating-hour boundary), pause for a poll cycle. Otherwise
  // the projection will fire bots that land 50-80 positions BELOW target
  // because between the fire decision and bot completion, 50+ drivers move
  // out of waiting → dispatched.
  if (queueShrinkageDetected) {
    return {
      action:  'wait',
      reason:  'queue_shrinking',
      secondsUntilFire: 30, // re-poll soon
      logLine: `[Pos] ${veh} — ⏸ queue shrinking (target ${effectivePosition}, queue ${waitingCount}) — waiting for purge to settle`,
      metrics: { ...baseMetrics, queueSize: waitingCount },
    };
  }

  // ─── Projection and fire decision ─────────────────────────────────────────
  // Fire as soon as projection reaches target — bounded above by maxAcceptable.
  // Bias correction is layered in to compensate for systematic landing errors
  // observed in recent history.
  //
  // The LEAD (how many positions early we fire) is clamped to maxLeadPositions
  // — see POS_MAX_LEAD for the full rationale. In one line: lead is the
  // worst-case undershoot, so the clamp hard-bounds landings at target − 9.
  // The drift estimate still matters BELOW the clamp (calm mornings fire with
  // lead 5–10 as before); what it can no longer do is extrapolate a burst
  // spike into firing 40–90 positions early (Jun 03: drift 98 → landed −68).
  // A clamped lead also keeps the projection-exceeds-max rail honest: it can
  // only trip when the queue itself is within lead of max, not because a
  // one-tick rate spike inflated the forecast (the Jun 04 false skips).
  const rawLead          = estimatedDrift + biasCorrection;
  // Growth-scaled cap (see GROWTH_LEAD_ENABLED): lead is spent undershoot, so
  // never spend more of it than the queue's measured growth can repay during
  // the commit. Calm (≤0.3/s) → lead 2–3 (was 10 via drift-floor+bias — the
  // −11…−13 pre-storm class); any burst rate (≥2.7/s) → 10, unchanged.
  const growthLeadCap    = growthLeadEnabled
    ? Math.max(2, Math.ceil(2 + effectiveGrowthRate * 3))
    : Infinity;
  let   lead             = Math.min(rawLead, maxLeadPositions, growthLeadCap);
  let   leadClamped      = lead !== rawLead;

  // Avalanche-band lead (PREDICTIVE_LEAD) — BURST WINDOW ONLY, target in
  // [PRED_LEAD_MIN_TARGET, PRED_LEAD_MAX_TARGET].
  // The flat clamp above pins the lead at ≤10, which cannot cover the drift the
  // queue accrues during SAN's commit latency on a storm (landings ran +33 above
  // queue-at-fire). This block replaces it for the band that actually suffers.
  // It used to size the lead as D = clamp(velocity × (floor + slope×inflight)):
  // that shape was retired on 2026-08-10 after 9 live storms — see the block
  // below and the 08-10 addendum in OVERSHOOT-PREDICTIVE-LEAD.md. The surviving
  // property is the one that matters: projectedLanding = effectiveQueue + lead
  // stays a genuine landing estimate, so the fire rail (≥ target) and the
  // past-max rail (> max) both remain correct.
  // Ladder-chain suppression: our own serialized chain moves the display at
  // ~0.2-0.4/s, which can graze the 0.5/s move gate over the 8s velocity
  // window. Velocity ≥ 1.0/s is beyond what the chain can produce (≤ 2 fires
  // per tick, ~5s commits) — that is a genuine storm and pred-lead resumes.
  const ladderChainActive = Date.now() - ladderLastFireMs < 30_000
    && observedVelocity < 1.0;
  const predLeadActive = PREDICTIVE_LEAD && inBurstWindow
    && effectivePosition >= PRED_LEAD_MIN_TARGET
    && effectivePosition <= PRED_LEAD_MAX_TARGET
    && !ladderChainActive;
  // Inside the avalanche band, once the queue is genuinely moving, SIZE the lead
  // to the drift we can predict at click time from INFLIGHT:
  //   D = clamp(PRED_DRIFT_INTERCEPT + PRED_DRIFT_SLOPE·inflight, FLOOR, CAP)
  // Why inflight and not the old v×latency: a fresh 10-day live analysis (563
  // band fires, logs 08-01..08-10) found velocity is a trailing slope that can't
  // see the avalanche step (corr with drift −0.08), while inflight — our own
  // clicked-but-uncommitted fires — LEADS the drift (corr 0.59), because our own
  // pending adds are what push the queue past the target. It also fixes the flat
  // `lead = CAP` shape this replaced: that under-covered the high-drift fires and
  // over-fired the calm ones. Sim (transform error = drift − D, 10 days): the
  // flat-30 branch gave >+40 12% / median +13; this gives >+40 1% / median +3,
  // and the −30… now −45 guarantee below HOLDS structurally (worst −23), because
  // D reaches CAP only at high inflight, which only happens mid-storm where the
  // queue never stalls. See OVERSHOOT-PREDICTIVE-LEAD.md §2026-08-11.
  const predLeadMoving = observedVelocity >= PRED_LEAD_MOVE_RATE;
  if (predLeadActive) {
    if (predLeadMoving) {
      lead = Math.max(
        PRED_LEAD_FLOOR,
        Math.min(PRED_LEAD_CAP, Math.round(PRED_DRIFT_INTERCEPT + PRED_DRIFT_SLOPE * currentInflight)),
      );
    } else {
      // Queue not yet moving: keep the old conservative velocity estimate so a
      // morning whose storm never arrives does not land the whole fleet deep.
      const predLatS = PRED_LAT_FLOOR_S + PRED_LAT_SLOPE_S * currentInflight;
      lead = Math.min(Math.round(observedVelocity * predLatS), PRED_LEAD_CAP);
    }
    leadClamped = false; // predictive path is not the flat clamp — see predLeadNote
  }
  const predLeadNote = predLeadActive
    ? (predLeadMoving
        ? ` [pred-lead ${lead} = clamp(${PRED_DRIFT_INTERCEPT}+${PRED_DRIFT_SLOPE}×${currentInflight} inflight, ${PRED_LEAD_FLOOR}, ${PRED_LEAD_CAP}) (v${observedVelocity.toFixed(2)}/s moving)]`
        : ` [pred-lead ${lead} = v${observedVelocity.toFixed(2)}×${(PRED_LAT_FLOOR_S + PRED_LAT_SLOPE_S * currentInflight).toFixed(1)}s (inflight ${currentInflight}, queue static)]`)
    : '';

  // Fleet-landing true-tail probe (FLEET_PROBE_ENABLED): if a FRESH genuine
  // landing shows the real tail is above SAN's (stale) displayed count, fire on
  // that instead. effectiveQueue ≥ waitingCount (a max) ⇒ never fires LATER than
  // today; effectiveQueue ≤ true tail (a landing is a valid lower bound) ⇒ never
  // fires early in true-position terms, so undershoot stays ≥ −9. Capped against
  // a contaminated landing. The past-max rail below stays on the DISPLAYED
  // projection, so the probe can only bring a fire forward, never cause a skip.
  let effectiveQueue = waitingCount;
  let probeNote      = '';
  if (FLEET_PROBE_ENABLED) {
    const ageMs      = Date.now() - lastFleetLanding.atMs;
    const probeFloor = lastFleetLanding.position - 1;
    if (ageMs <= FLEET_PROBE_FRESH_MS && probeFloor > waitingCount) {
      effectiveQueue = Math.min(probeFloor, waitingCount + FLEET_PROBE_MAX_LEAD);
      probeNote      = ` [fleet-probe ${waitingCount}→${effectiveQueue} ` +
                       `(landing ${lastFleetLanding.position}, ${(ageMs / 1000).toFixed(1)}s ago)]`;
    }
  }

  const displayedProjection = waitingCount + lead;   // SAN's stale view — drives the past-max rail
  const projectedLanding    = effectiveQueue + lead; // probe-aware — drives the fire decision
  const leadNote            = (leadClamped
    ? ` (lead clamped ${rawLead.toFixed(1)} → ${lead})`
    : '') + predLeadNote;

  // If the projection says we'd land ABOVE maxAcceptable, the train has left
  // the station: every second we wait, the queue grows further past max. The
  // 2026-05-27 #695 incident (target 105, max 125, fired anyway, landed at
  // 167) was exactly this — projection was 167 but the code only checked
  // projection ≥ target. Record the miss instead of producing a +62 landing.
  // The earlier `waitingCount > maxAcceptable` rail still catches the case
  // where the queue is already past max; this one covers "still below max
  // right now, but the projected landing is past max."
  if (displayedProjection > maxAcceptable) {
    const missMetrics = {
      ...baseMetrics,
      queueSize:        waitingCount,
      growthRate:       effectiveGrowthRate,
      estimatedDrift,
      predictedLanding: Math.round(displayedProjection),
    };
    const missDecision = {
      action:  'missed_impossible',
      reason:  'projection_exceeds_max',
      logLine: `[Pos] ${veh} — ✗ projection ${displayedProjection.toFixed(1)} > max ${maxAcceptable} ` +
               `(queue ${waitingCount} + lead ${Number.isInteger(lead) ? lead : lead.toFixed(1)}${leadNote}, ` +
               `target ${effectivePosition}) — too late, skipping`,
      metrics: missMetrics,
    };
    if (!PLACE_ANYWAY_ON) return missDecision;
    return {
      action:            'place_anyway',
      reason:            'projection_exceeds_max',
      effectivePosition,
      maxAcceptable,
      fallbackFrom:      missDecision, // caller records this if it declines to fire (warm-only + unarmed)
      logLine: `[Pos] ${veh} — ⚠ place-anyway: projection ${displayedProjection.toFixed(1)} > max ${maxAcceptable} ` +
               `(queue ${waitingCount} + lead ${Number.isInteger(lead) ? lead : lead.toFixed(1)}, ` +
               `target ${effectivePosition}) — firing best-effort to avoid a miss`,
      fireOpts: {
        growthRate:            effectiveGrowthRate,
        estimatedDrift,
        predictedLanding:      Math.round(displayedProjection),
        maxAcceptablePosition: maxAcceptable,
        bestEffort:            true,
      },
      metrics: missMetrics,
    };
  }

  // ─── Storm-onset early fire (MONITOR_ONSET_FIRE — see the constant block) ──
  // POSITION-only rule, no time anywhere: gap = target − effectiveQueue. Since
  // effectiveQueue is a proven LOWER bound of the true tail, firing while
  // gap ≤ ONSET_CAP bounds the worst-case landing at target − ONSET_CAP even
  // if the storm dies on the click (landing ≥ effectiveQueue + 1). Drivers
  // whose gap is still wider than the cap are HELD — the storm's own
  // processing raises the tail toward them within seconds, so they become
  // eligible before the display step ever shows it.
  const onsetGap      = effectivePosition - effectiveQueue;
  // Target-horizon guard (see ONSET_SAFE_HORIZON block): the deep allowance is
  // prior-safe only for targets the storm is certain to run past. Targets near
  // the historical storm-death boundary get a tight cap; beyond it the onset
  // rule is off — the plain lead rule fires them on proven queue, which the
  // post-storm drain serves at −6…−9 instead of the cap's −12…−19.
  const onsetAllow = effectivePosition <= onsetSafeHorizon
    ? onsetCap
    : (effectivePosition <= onsetMidHorizon ? Math.min(onsetCap, onsetMidCap) : 0);
  const onsetEligible = (ONSET_FIRE_LIVE || ONSET_FIRE_SHADOW)
    && onsetActive && onsetGap > 0 && onsetGap <= onsetAllow;

  // ─── Pre-onset ladder (MONITOR_LADDER — see the constant block) ────────────
  // Same gap as the onset rule (target − effectiveQueue) but the OPPOSITE
  // regime gate: the ladder only runs while the morning is still calm (no
  // onset, velocity under the storm gates) inside its wall-clock window. The
  // moment real storm evidence appears, onsetActive/velocity flip and the
  // storm machinery owns every subsequent fire. Landing bound: ≥ effectiveQueue
  // + 1 ≥ target − LADDER_GAP + 1 — in-band on the undershoot side by
  // construction at the default gap.
  // Seed budget for THIS target (see LADDER_SEED_GAP): full budget only inside
  // the avalanche band, the −30-contract cap everywhere else — a shallow
  // target must never be seeded 40-60 under.
  const seedBudget = (effectivePosition >= PRED_LEAD_MIN_TARGET
      && effectivePosition <= PRED_LEAD_MAX_TARGET)
    ? LADDER_SEED_GAP
    : Math.min(LADDER_SEED_GAP, LADDER_SEED_SHALLOW);
  // GROWTH-SCALED depth (see the SEED growth-gate block): the seed may spend
  // undershoot only in proportion to how much the list has actually climbed.
  // Dead calm ⇒ seedRise < MIN_RISE ⇒ growthAllow 0 ⇒ NO growth seed. As the
  // ramp builds, the allowed depth grows with it, clamped to the scoped budget.
  const seedGrowing = seedRise >= LADDER_SEED_MIN_RISE;
  const growthAllow = seedGrowing
    ? Math.min(seedBudget, Math.round(seedRise * LADDER_SEED_GAP_PER_RISE))
    : 0;
  // PROACTIVE-scaled depth (see the LADDER_PROACTIVE block): inside the daily
  // storm window the allowed depth ramps with the CLOCK — shallow (gap 11+1) at
  // _AFTER, full scoped budget by _PEAK — so a driver is placed deep only as the
  // leap becomes imminent by time, no growth signal required.
  const proactiveAllow = (proactiveOpen && (LADDER_PROACTIVE_LIVE || LADDER_PROACTIVE_SHADOW))
    ? Math.min(seedBudget, Math.max(LADDER_GAP + 1,
        Math.round(LADDER_GAP + (seedBudget - LADDER_GAP) * Math.min(1, Math.max(0, proactiveFrac)))))
    : 0;
  // Two allowances: what may actually FIRE (growth always fires; proactive fires
  // only when LIVE), and the full FUNNEL incl. proactive-shadow (for log-only).
  const seedFireAllow   = Math.max(growthAllow, LADDER_PROACTIVE_LIVE ? proactiveAllow : 0);
  const seedFunnelAllow = Math.max(growthAllow, proactiveAllow);

  const ladderGapAllow = seedPromote ? seedFireAllow : LADDER_GAP;
  const ladderEligible = (LADDER_LIVE || LADDER_SHADOW || LADDER_PROACTIVE_LIVE)
    && (seedPromote ? (seedWindowOpen && seedFireAllow > 0) : ladderWindowOpen)
    && !onsetActive
    && observedVelocity < LADDER_MAX_VEL
    && onsetGap > 0 && onsetGap <= ladderGapAllow;

  // Seed candidate (see LADDER_SEED_GAP): a waiting driver the gap-11 chain
  // cannot reach but the seed budget can — via growth OR the proactive window.
  // Not fired here — runLadderSeedPass (live) / runLadderSeedShadowPass (shadow)
  // promotes ONE per tick, lowest target first, so seeds land ascending.
  const seedModeOn = LADDER_LIVE || LADDER_PROACTIVE_LIVE || LADDER_PROACTIVE_SHADOW;
  const seedInFunnel = !seedPromote
    && seedModeOn && LADDER_SEED_GAP > 0
    && seedWindowOpen
    && !onsetActive
    && observedVelocity < LADDER_MAX_VEL
    && onsetGap > LADDER_GAP && onsetGap <= seedFunnelAllow;
  const seedCandidate = seedInFunnel;            // in the funnel (may be shadow-only)
  const seedCanFire   = seedInFunnel && onsetGap <= seedFireAllow; // fire-allowed this tick

  // ─── HARD UNDERSHOOT FLOOR (gated targets — the −30 guarantee) ────────────
  // Never let ANY fire path (predictive lead OR onset OR fleet-probe) place a
  // gated driver while the DISPLAYED queue is still more than the floor below
  // target. waitingCount is a lower bound on the true tail (SAN's display only
  // lags) and SAN appends at the tail, so the worst-case landing is ≥
  // waitingCount + 1 ≥ target − FLOOR + 1 ⇒ undershoot can never be worse than
  // −(FLOOR−1), independent of prediction error, a probe over-read, or the storm
  // stalling on the click. It only ever HOLDS a fire (never fires earlier), so it
  // cannot cause a miss — a growing storm lifts the displayed queue past the
  // floor within seconds and the driver fires then.
  // Banded floor: −45 only inside the avalanche band [MIN, MAX] (where the
  // aggressive inflight-scaled lead runs); −30 for deeper targets (≥200), which
  // keep the original guarantee.
  const hardFloorPositions = effectivePosition <= PRED_LEAD_MAX_TARGET
    ? PRED_LEAD_HARD_FLOOR
    : PRED_LEAD_OUTER_FLOOR;
  const hardFloorHold = PREDICTIVE_LEAD
    && effectivePosition >= PRED_LEAD_MIN_TARGET
    && waitingCount < effectivePosition - hardFloorPositions;
  const hardFloorNote = hardFloorHold
    ? ` [hard-floor: hold until displayed ≥ ${effectivePosition - hardFloorPositions} (−${hardFloorPositions} guarantee)]`
    : '';

  const projectionReached = projectedLanding >= effectivePosition;
  const shouldFire        = !hardFloorHold
    && (projectionReached
        || (ONSET_FIRE_LIVE && onsetEligible)
        || (LADDER_LIVE && ladderEligible));

  // secondsUntilFire drives adaptive polling — how soon do we expect to fire?
  // Negative projection (already past target) → 0; no growth → Infinity.
  const positionsUntilFire = effectivePosition - projectedLanding;
  const secondsUntilFire   = effectiveGrowthRate > 0 && positionsUntilFire > 0
    ? positionsUntilFire / effectiveGrowthRate
    : (positionsUntilFire <= 0 ? 0 : Infinity);

  if (shouldFire) {
    // Early-fire attribution: onset outranks ladder in the label (both are
    // gap-rules with the same landing bound; onset implies a storm is live).
    const onsetOnly  = !projectionReached && ONSET_FIRE_LIVE && onsetEligible;
    const ladderOnly = !projectionReached && !onsetOnly;
    return {
      action:  'fire',
      reason:  onsetOnly ? 'onset_early_fire'
             : ladderOnly ? 'ladder_fire'
             : 'projection_reached_target',
      effectivePosition,
      maxAcceptable,
      secondsUntilFire: (onsetOnly || ladderOnly) ? 0 : secondsUntilFire,
      logLine: onsetOnly
        ? `[Pos] ${veh} — ⚡ ONSET early fire: queue ${effectiveQueue}${probeNote}, target ${effectivePosition} ` +
          `(early by ${onsetGap} ≤ cap ${onsetAllow}, rate ${effectiveGrowthRate.toFixed(2)}/s) — firing before the chunk`
        : ladderOnly
        ? `[Pos] ${veh} — 🪜 LADDER${seedPromote && proactiveOpen && growthAllow < onsetGap ? ' PROACTIVE' : ''} fire: queue ${effectiveQueue}${probeNote}, target ${effectivePosition} ` +
          `(${seedPromote ? `seed gap ${onsetGap} ≤ ${ladderGapAllow} (rise +${seedRise}/${SEED_RISE_WINDOW_S}s, clock ${Math.round(Math.min(1,Math.max(0,proactiveFrac))*100)}%)` : `gap ${onsetGap} ≤ ${ladderGapAllow}`}, calm v${observedVelocity.toFixed(2)}/s) — placing ahead of the storm`
        : `[Pos] ${veh} — ✓ queue ${effectiveQueue}${probeNote} + lead ${Number.isInteger(lead) ? lead : lead.toFixed(1)}` +
          `${leadNote ? leadNote : ` (drift ${estimatedDrift}${biasCorrection !== 0 ? ` + bias ${biasCorrection.toFixed(1)}` : ''})`} ` +
          `= ${projectedLanding.toFixed(1)} ≥ target ${effectivePosition} ` +
          `(max ${maxAcceptable}, rate ${effectiveGrowthRate.toFixed(2)}/s, ` +
          `horizon ${horizonSeconds.toFixed(0)}s, botEst ${(botExecMs/1000).toFixed(1)}s, ` +
          `samples ${botSamplesCount}) — firing bot`,
      fireOpts: {
        growthRate:            effectiveGrowthRate,
        estimatedDrift,
        predictedLanding:      (onsetOnly || ladderOnly) ? effectiveQueue + 1 : Math.round(projectedLanding),
        maxAcceptablePosition: maxAcceptable,
      },
    };
  }

  // ─── Wait ─────────────────────────────────────────────────────────────────
  // Shadow mode: the onset rule WOULD have fired here — log it so a shadow
  // morning can be replayed against actual landings before going live.
  const shadowNote = (ONSET_FIRE_SHADOW && onsetEligible
    ? ` [ONSET-SHADOW: would fire early by ${onsetGap} ≤ cap ${onsetAllow}]`
    : '') + (LADDER_SHADOW && ladderEligible
    ? ` [LADDER-SHADOW: would fire at gap ${onsetGap} ≤ ${LADDER_GAP}]`
    : '');
  return {
    action:  'wait',
    reason:  'projected_below_target',
    secondsUntilFire,
    logLine: `[Pos] ${veh} — waiting (queue: ${effectiveQueue}${probeNote}, drift: ${estimatedDrift}, ` +
             `bias: ${biasCorrection.toFixed(1)}, projected: ${projectedLanding.toFixed(1)}${leadNote}, ` +
             `target: ${effectivePosition}, max: ${maxAcceptable}, ` +
             `secsToFire: ${Number.isFinite(secondsUntilFire) ? secondsUntilFire.toFixed(0) : '∞'})${hardFloorNote}${shadowNote}`,
    seedCandidate,
    seedCanFire,
    seedProactiveOnly: seedCandidate && !seedCanFire, // in funnel via proactive-shadow depth only
    effectiveQueueAtDecision: effectiveQueue,
    metrics: {
      ...baseMetrics,
      queueSize:        waitingCount,
      growthRate:       effectiveGrowthRate,
      estimatedDrift,
      predictedLanding: Math.round(projectedLanding),
    },
  };
}

// ─── Core poll tick ──────────────────────────────────────────────────────────
/**
 * Ladder seed pass (MONITOR_LADDER_SEED_GAP — see the LADDER_SEED constant
 * block). Runs after the decision loop on ticks where the gap-11 chain made no
 * progress and nothing of ours is in flight: promotes exactly ONE still-waiting
 * seed candidate, lowest target first, by re-evaluating it with seedPromote
 * (which widens the ladder gap to the seed budget). One per tick + the
 * inflight gate serialize seeds to SAN's accurate commit pace, and each commit
 * raises the queue toward the next candidate. Mutates fireBatch and marks the
 * fired state, mirroring runTickPipePass.
 */
function runLadderSeedPass(fireBatch, seedWaiters, decisionCtx, ladderFiresThisTick, evaluate = evaluatePositionScheduler) {
  if (!(LADDER_LIVE || LADDER_PROACTIVE_LIVE) || LADDER_SEED_GAP <= 0 || seedWaiters.length === 0) return 0;
  // Concurrency budget: keep at most LADDER_SEED_MAX_INFLIGHT of our own seeds in
  // flight (this tick's ladder fires + already-pending commits both count). With
  // the default N=1 this collapses to the original serialization EXACTLY — fire a
  // single seed only when the gap-chain made no progress AND nothing is in flight
  // (budget = 1 − 0 − 0 = 1; any inflight or ladder fire drives budget ≤ 0 → skip).
  // N>1 (the front-loaded chain) tops the in-flight set back up to N each tick, so
  // seeds commit at ~N/commit-latency ≈ 1/s while concurrency stays at SAN's
  // accurate low-commit knee. Lowest target first so the chain lands ascending.
  const budget = LADDER_SEED_MAX_INFLIGHT - (decisionCtx.currentInflight ?? 0) - ladderFiresThisTick;
  if (budget <= 0) return 0;
  seedWaiters.sort((a, b) => (a.target ?? Infinity) - (b.target ?? Infinity));
  let promoted = 0;
  for (const w of seedWaiters) {
    if (promoted >= budget) break;
    if (w.state.positionFiredToday) continue;
    try {
      const d2 = evaluate(w.state, { ...decisionCtx, seedPromote: true });
      if (d2.action !== 'fire') continue;
      console.log(d2.logLine);
      w.state.positionFiredToday = true;
      ladderLastFireMs = Date.now();
      ladderAddsCommitted++; // our own add — excluded from the growth signal
      fireBatch.push({ driverId: w.driverId, state: w.state, decision: d2 });
      promoted++;
    } catch (err) {
      console.error(`[Pos] ladder seed pass failed for #${w.state?.vehicleNumber}: ${err.message}`);
    }
  }
  return promoted;
}

/**
 * Proactive-seed SHADOW pass (MONITOR_LADDER_PROACTIVE=shadow). Logs — never
 * fires — the one lowest-target driver the proactive window WOULD seed this
 * tick that the live paths did NOT (i.e. justified by the proactive depth but
 * not by growth). Advances through the roster via ladderShadowSeeded so each
 * candidate is logged once per day, giving a faithful funnel + timing stream to
 * review before flipping to live. NOTE: shadow cannot move SAN's real queue, so
 * the logged landing is the CURRENT-queue lower bound (live would land higher as
 * our own commits climb) — the quantitative walk is measured by the replay.
 */
function runLadderSeedShadowPass(shadowWaiters, nowMs = Date.now()) {
  if (!LADDER_PROACTIVE_SHADOW || shadowWaiters.length === 0) return 0;
  const dayKey = new Date(nowMs).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  if (dayKey !== ladderShadowDay) { ladderShadowDay = dayKey; ladderShadowSeeded = new Set(); }
  shadowWaiters.sort((a, b) => (a.target ?? Infinity) - (b.target ?? Infinity));
  for (const w of shadowWaiters) {
    if (ladderShadowSeeded.has(w.driverId)) continue;
    ladderShadowSeeded.add(w.driverId);
    const land = (w.effQ ?? 0) + 1;
    console.log(
      `[Pos] #${w.state?.vehicleNumber ?? w.driverId} — 🪜 PROACTIVE-SHADOW would seed: ` +
      `queue ${w.effQ}, target ${w.target} (gap ${w.target - (w.effQ ?? 0)}, ~land ${land}, err ${land - w.target}) ` +
      `— log-only, would place ahead of the storm`,
    );
    return 1;
  }
  return 0;
}

/**
 * Tick-pipe re-evaluation pass (MONITOR_TICK_PIPE_LEAD — see the constant
 * block for the full rationale). Re-runs the tick's still-waiting drivers with
 * this tick's own fire batch counted into currentInflight, lowest target
 * first, growing the count as fires are added — so the k-th added fire sees
 * exactly the batch it will stand behind. Mutates fireBatch in place (the
 * caller's target-ascending sort runs after this) and marks fired states.
 * Pure otherwise; `evaluate` is injectable for tests.
 */
function runTickPipePass(fireBatch, waiters, decisionCtx, evaluate = evaluatePositionScheduler) {
  if (!TICK_PIPE_LEAD || fireBatch.length === 0 || waiters.length === 0) return 0;
  waiters.sort((a, b) => (a.target ?? Infinity) - (b.target ?? Infinity));
  let addedTotal = 0;
  // Fixpoint: an added fire deepens the pipe for every remaining waiter, which
  // can cross another threshold. Lead is capped, targets are sorted, and each
  // pass must add at least one fire to continue — 6 passes is far past the
  // worst chain the cap allows.
  for (let pass = 0, added = true; added && pass < 6; pass++) {
    added = false;
    for (const w of waiters) {
      if (w.state.positionFiredToday) continue;
      try {
        const d2 = evaluate(w.state, {
          ...decisionCtx,
          currentInflight: (decisionCtx.currentInflight ?? 0) + fireBatch.length,
        });
        if (d2.action !== 'fire') continue;
        console.log(`${d2.logLine} [tick-pipe: ${fireBatch.length} same-tick fires ahead]`);
        w.state.positionFiredToday = true;
        fireBatch.push({ driverId: w.driverId, state: w.state, decision: d2 });
        added = true;
        addedTotal++;
      } catch (err) {
        console.error(`[Pos] tick-pipe re-eval failed for #${w.state.vehicleNumber}: ${err.message}`);
      }
    }
  }
  return addedTotal;
}

async function poll() {
  if (watches.size === 0) return; // nothing to watch — skip fetch (cost = 0)

  // Daily counter reset at midnight Pacific
  const currentDayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (currentDayPT !== todayPT) {
    todayPT = currentDayPT;
    for (const s of watches.values()) {
      s.requeueCountToday  = 0;
      s.positionFiredToday = false;
      s.landedPositionToday = null; // yesterday's landing must not feed today's diagnostics
      s.underRescueFlagged  = false; // rescue detector re-arms each day
      s.lastPosDecision    = null; // new day → next decision will write a fresh row
      s.pendingTrackingId  = null;
      s.consecutiveAlreadyQueued = 0;
      s.requeueBlockedReason     = null;

      // Carryover: V Holding clears overnight (SAN dispatches the leftovers and
      // empties the list before ~3 AM PT), so a driver still in queue at midnight
      // will be dropped before morning. Tag them so the state machine doesn't
      // immediately flip hasBeenSeen back to true on the next poll — that path
      // makes the position scheduler skip the driver for the day even though
      // SAN is about to clear them. The flag is cleared automatically when the
      // driver leaves V Holding (see poll loop below).
      s.inQueueFromCarryover = !!s.hasBeenSeen;
      // Durable, day-scoped "this driver was a leftover at midnight" flag. Unlike
      // inQueueFromCarryover (which the debounce clears once SAN drops them), this
      // stays true all day so a leftover that gets dropped then RE-APPEARS before
      // firing is re-protected instead of mislabelled "already in queue" (the
      // released-too-late case). Persisted via a carryover_marker log below so it
      // also survives a restart between midnight and the morning fire window.
      s.wasCarryoverToday    = !!s.hasBeenSeen;

      s.hasBeenSeen        = false;
      s.state              = s.inQueueFromCarryover ? 'in_queue' : 'watching';
      s.carryoverAbsentPolls = 0;   // debounce counter for the carryover-cleared signal
      s.terminalSeen       = false;
      s.terminalCheckCount = 0;
      s.terminalName       = null;
      s.terminalPosition   = null;
      s.atTerminalSince    = null;
      s.manuallyRemovedAt  = null;  // new day → driver can be auto-managed again
      s.earlyJoinDetectedAt = null;
      s.earlyJoinAtPosition = null;
      s.dispatchNotifyPending = false;
      s.redzoneRemoveCountToday   = 0;     // new day → red-zone auto-remove budget resets
      s.redzoneRemoveLastAttemptMs = 0;
      s.redzoneRemovePending      = false;
    }
    // New day → fresh storm tracking (yesterday's onset must not leak forward).
    onsetState = freshOnsetState();
    borrowPinnedSecondId = null; // new day → re-pin the single second borrow account
    console.log('[Monitor] Daily reset — counters and visibility state cleared');
    broadcast('daily_reset', { date: currentDayPT });

    // Persist a durable carryover marker for every leftover. This is what lets
    // addWatch() rebuild carryover protection after a restart between midnight
    // and the morning fire window — the window where neither this reset nor the
    // 3 AM re-arm runs again, and where a restart used to come back unprotected.
    // Runs ONCE per day (this block only fires on the genuine date rollover, not
    // a mid-day restart, since todayPT inits to the current day). Independent of
    // the remove below so protection holds even with the remove disabled.
    const leftovers = [...watches.values()].filter((s) => s.inQueueFromCarryover);
    if (leftovers.length) {
      const triggeredAt = new Date();
      for (const s of leftovers) {
        // trigger_type must equal Log.CARRYOVER_MARKER (canonical const in Log.js,
        // where the matching read queries live). Inlined here because Log is a
        // class whose static getter doesn't survive jest's automock.
        Log.create({ driver_id: s.driverId, triggered_at: triggeredAt, trigger_type: 'carryover_marker', status: 'info' })
          .catch((err) => console.warn(`[Monitor] carryover marker for #${s.vehicleNumber} failed: ${err.message}`));
      }
      console.log(`[Monitor] Daily reset — ${leftovers.length} leftover driver(s) tagged carryover (protected until SAN drops them)`);
    }

    // OPTIONAL active remove (CARRYOVER_REMOVE_ENABLED, off by default). Tries to
    // pull leftovers out of yesterday's queue so SAN can't paper-dispatch them off
    // the draining front overnight (→ no-show → benched → miss their target).
    // Routed through the jobQueue (concurrency-capped) and fire-and-forget so it
    // never blocks the poll. NOTE: this is pure best-effort and CANNOT strand
    // anyone — removeCarryoverLeftover never touches the protection flags.
    if (CARRYOVER_REMOVE_ENABLED && leftovers.length) {
      console.log(`[Monitor] Daily reset — attempting active remove of ${leftovers.length} leftover driver(s)`);
      for (const s of leftovers) {
        jobQueue.enqueue(() => removeCarryoverLeftover(s.driverId, s.vehicleNumber)).catch(() => {});
      }
    }
  }

  // ─── Position-window arming (3 AM PT) ─────────────────────────────────────────
  // SAN's V Holding clears overnight, so any manual bot run a driver makes
  // before ~3 AM lands them at a position far below their actual target. The
  // midnight reset only clears requeueCountToday and (for carryover drivers)
  // tags them as such — it does NOT reset the flags set by a SUCCESSFUL
  // manual or auto-fire that happened between 00:00 and the start of the
  // position window. That left drivers like #4007 stuck at #28 from a 12:30 AM
  // manual run, blocked from re-firing at their real target later.
  //
  // Fires once per day at the open of the position window — see armPosition
  // WindowForToday() below for what gets reset and why.
  if (isWithinPositionHours() && positionWindowArmedForDate !== currentDayPT) {
    positionWindowArmedForDate = currentDayPT;
    armPositionWindowForToday(currentDayPT);
    // Proactively pull any leftover SAN didn't purge overnight (still in V Holding
    // at the window open) and arm it to fire fresh at target — instead of waiting
    // hours for SAN's drop, by which point the tail has grown past max. Confirmed
    // removals only; a failed/unconfirmed drop leaves carryover protection intact.
    dropAndArmCarryoverLeftovers(currentDayPT);
  }

  const t0 = Date.now();
  let html;

  try {
    const res = await fetchPage(QUEUE_URL);
    html = await res.text();
  } catch (err) {
    lastPollStats = { ...lastPollStats, pollAt: new Date(), error: err.message, fetchMs: Date.now() - t0 };
    broadcast('poll_error', { error: err.message });
    console.warn(`[Monitor] Poll failed after ${RETRY_COUNT} attempt(s): ${err.message}`);
    return;
  }

  const fetchMs = Date.now() - t0;
  prevObservationAt = lastObservationAt;
  lastObservationAt = Date.now(); // record when this snapshot was taken
  const { dispatched, dispatchedDest, waiting, notAuthorized } = parseQueue(html);

  lastPollStats = {
    pollAt:       new Date(),
    totalInQueue: dispatched.size + waiting.size,
    dispatched:   dispatched.size,
    waiting:      waiting.size,
    fetchMs,
    queueUrl:     QUEUE_URL,
    error:        null,
  };

  broadcast('poll', {
    ...lastPollStats,
    operatingHours:  { active: isWithinOperatingHours(),  startHour: OP_START_HOUR,  endHour: OP_END_HOUR  },
    positionHours:   { active: isWithinPositionHours(),   startHour: POS_START_HOUR, endHour: POS_END_HOUR },
  });

  const waitingCount = waiting.size;

  // ─── Queue growth rate (used by position-schedule lead calculation) ──────────
  // Rate is in drivers/second so horizon math stays correct even if poll intervals drift.
  //
  // Three rate signals, take the max:
  //   lastPollRate      — drivers added since the previous poll ÷ elapsed seconds
  //   shortWindowRate   — drivers added over the last SHORT_WINDOW_POLLS polls ÷ elapsed
  //                       more stable than a single delta, reacts faster than EMA
  //   EMERGENCY_SURGE_RATE — configurable floor (default 0.5/s) that protects the
  //                       cold-start case (first poll of the morning, no prior data)
  //
  // smoothedGrowthRate (EMA α=0.7) is kept as an additional signal alongside the others.
  // prevWaitingCount is null on first tick → skip to avoid a false 0→N spike.

  // Maintain rolling observation buffer (oldest first)
  recentObservations.push({ count: waitingCount, observedAt: lastObservationAt });
  if (recentObservations.length > SHORT_WINDOW_POLLS + 1) recentObservations.shift();
  // Time-bounded buffer for the predictive-lead velocity (see observedVelocity).
  recordVelocityObservation(waitingCount, lastObservationAt);
  // Longer-window buffer for the ladder seed growth gate (see sustainedRise).
  recordSeedQueueObservation(waitingCount, lastObservationAt);

  // Hoisted so the snapshot recording below has access to the raw signals.
  let lastPollRate        = null;
  let shortWindowRate     = null;
  let effectiveGrowthRate = EMERGENCY_SURGE_RATE; // floor — never starts at zero
  let queueShrinkageDetected = false;
  if (prevWaitingCount !== null && prevObservationAt !== null) {
    const secondsElapsed = Math.max(1, (lastObservationAt - prevObservationAt) / 1000);
    const rawDelta       = waitingCount - prevWaitingCount; // signed
    const rawGrowth      = Math.max(0, rawDelta);
    lastPollRate         = rawGrowth / secondsElapsed;

    // Detect queue purges: a big drop within a single poll window indicates
    // SAN just promoted a batch from waiting → dispatched (common at 5 AM
    // dispatch open). The 10-driver threshold is intentionally well above
    // normal noise so we don't pause on individual departures.
    if (rawDelta <= -10) queueShrinkageDetected = true;

    smoothedGrowthRate = smoothedGrowthRate * 0.3 + lastPollRate * 0.7; // EMA α=0.7

    // Short-window rate: slope over the last SHORT_WINDOW_POLLS observations
    shortWindowRate = 0;
    if (recentObservations.length >= SHORT_WINDOW_POLLS) {
      const oldest = recentObservations[0];
      const windowSecs = Math.max(1, (lastObservationAt - oldest.observedAt) / 1000);
      shortWindowRate = Math.max(0, (waitingCount - oldest.count) / windowSecs);
    }

    effectiveGrowthRate = Math.max(
      lastPollRate,
      shortWindowRate,
      smoothedGrowthRate,
      EMERGENCY_SURGE_RATE,
    );
  }
  prevWaitingCount = waitingCount;

  // ─── Snapshot for burst-pattern analysis ─────────────────────────────────
  // Fire-and-forget. One row per poll captures the full queue + prediction
  // state so we can later analyse position-dependent growth bursts
  // (e.g. "queue surges around position 115 on Saturdays at 5:30 AM").
  // The scheduler doesn't use this data at runtime — it's pure data collection.
  QueueSnapshot.record({
    waitingCount,
    dispatchedCount:     dispatched.size,
    notAuthorizedCount:  notAuthorized.size,
    lastPollRate,
    shortWindowRate,
    smoothedGrowthRate,
    effectiveGrowthRate,
    // Field name preserved for the existing bot_p95_ms column. The value is
    // now the median of fresh samples, not P95 — see botExecutionEstimateMs.
    // Future migration can rename the column to bot_est_ms when convenient.
    botP95Ms:            botExecutionEstimateMs(),
    botLatencySamples:   botLatencySamples.length,
    biasCorrection,
    pollIntervalMs:      currentPollDelayMs,
  }).catch((err) => console.error('[QueueSnapshot] insert failed:', err.message));

  // ─── Periodic bias correction refresh ─────────────────────────────────────
  // Recomputes median(actual - target) from recent position_tracking records.
  // Only runs every BIAS_REFRESH_EVERY ticks and only when we have enough data.
  //
  // The median is computed with outliers (|err|>30) already filtered out — see
  // PositionTracking.medianRecentError. The clamp below is the second line of
  // defense: if some new contamination path slips past the filter, the bias
  // still can't pull the predictor more than BIAS_CAP_POSITIONS off its raw
  // drift estimate. The clamp is logged when it actually trims so we can spot
  // regressions in the data quality.
  biasPollCount++;
  if (biasPollCount % BIAS_REFRESH_EVERY === 0) {
    PositionTracking.medianRecentError(30).then((med) => {
      if (med === null) return;
      const clamped = Math.max(-BIAS_CAP_POSITIONS, Math.min(BIAS_CAP_POSITIONS, med));
      const wasClamped = clamped !== med;
      biasCorrection = clamped;
      const sign = biasCorrection > 0 ? '+' : '';
      const note = wasClamped ? ` (clamped from ${med > 0 ? '+' : ''}${med.toFixed(1)})` : '';
      console.log(`[PosTracking] Bias correction updated: ${sign}${biasCorrection.toFixed(1)} positions${note}`);
    }).catch(() => {}); // non-blocking — ignore DB errors here
  }

  // One pass — O(n) with n = number of watches; each lookup is O(1) Map op
  const returnedFromTerminal = []; // drivers SAN auto-returned to V Holding mid-terminal

  for (const [driverId, state] of watches) {
    state._lastQueueSize = waitingCount; // keep fresh for logging

    if (state.state === 'requeuing') continue; // bot in-flight — skip this driver

    // Borrowed as a tail probe: this driver's account is being cycled
    // (add→sample→remove) by tailProbeService right now. Their transient
    // presence in V Holding is OURS, not a real placement — ignore it entirely
    // so we never record a probe position, mark them seen, or emit a
    // driver-facing event. They resume normal observation the instant they're
    // retired (borrowedAsProbe cleared), and only their real fire is ever shown.
    if (state.borrowedAsProbe) continue;

    const vn              = state.vehicleNorm;
    const inDispatched    = dispatched.has(vn);
    const inWaiting       = waiting.has(vn);
    const inNotAuthorized = notAuthorized.has(vn);
    const prev            = state.state;
    let   next            = prev;

    // Always update live position from the queue page on every tick
    const livePosition = waiting.get(vn) ?? dispatched.get(vn) ?? null;
    if (livePosition !== null) state.currentPosition = livePosition;

    // Carryover handling: drivers still in V Holding at midnight will be cleared
    // by SAN before morning. While inQueueFromCarryover is true we observe them
    // but DON'T flip hasBeenSeen — the position scheduler treats them as armed
    // for today so it can fire properly once SAN drops them. The flag is
    // cleared automatically the first poll the driver is no longer in V Holding.
    const isCarryover = state.inQueueFromCarryover;
    // A driver that was a leftover today and hasn't fired yet must NEVER earn
    // hasBeenSeen from passive observation — otherwise the scheduler's
    // "already in queue, skipping" branch wrongly fires for them. This guard is
    // what makes the carryover protection airtight: hasBeenSeen now flips true
    // only via a genuine fresh fire (the bot sets it on success), never from
    // seeing a leftover sitting in (or re-appearing in) the queue.
    const carryoverProtected = isCarryover || (state.wasCarryoverToday && !state.positionFiredToday);
    const markSeen    = () => { if (!carryoverProtected && !state.hasBeenSeen) state.hasBeenSeen = true; };

    // Red-zone VERIFICATION: a cab we sent an auto-remove for has now dropped out
    // of SAN's not_authorized set → the removal took. Confirm and clear the flag.
    // (The state-change broadcast at the end of the loop refreshes the UI.)
    if (state.redzoneRemovePending && !inNotAuthorized) {
      state.redzoneRemovePending = false;
      console.log(`[Monitor] #${state.vehicleNumber} ✓ red-zone auto-remove CONFIRMED — no longer not_authorized`);
    }

    if (inNotAuthorized) {
      // Driver is in the red "not authorized" zone — visible but blocked by SAN.
      // Do NOT set hasBeenSeen (they haven't earned a queue spot) and do NOT requeue.
      next = 'not_authorized';

      // Auto-remove: fire the same "Remove From Queue" bot the driver would run
      // by hand, so a blocked cab is pulled out (and free to rejoin) without them
      // having to touch SAN. Guarded by a per-cab cooldown + daily cap because the
      // ~00:00 carryover wave is re-listed by SAN within seconds (see REDZONE_*).
      // Fire-and-forget through the concurrency-capped jobQueue so it never blocks
      // the poll loop. NEVER touches carryover/hasBeenSeen flags (see the fn).
      if (
        REDZONE_AUTO_REMOVE_ENABLED
        && state.isActive
        && !state.manuallyRemovedAt
      ) {
        const decision = _redzoneRemoveDecision(state, Date.now());
        if (decision.allow) {
          state.redzoneRemoveCountToday  = (state.redzoneRemoveCountToday ?? 0) + 1;
          state.redzoneRemoveLastAttemptMs = Date.now();
          state.redzoneRemovePending     = true;
          console.log(`[Monitor] #${state.vehicleNumber} — in red zone (not_authorized), auto-remove attempt ${state.redzoneRemoveCountToday}/${REDZONE_REMOVE_MAX_PER_DAY}`);
          jobQueue.enqueue(() => autoRemoveNotAuthorized(driverId, state.vehicleNumber)).catch(() => {});
        }
      }
    } else if (inDispatched) {
      markSeen();
      state.lastSeenAt = new Date();
      const wasNewlyDispatched = prev !== 'dispatched' && !isCarryover;
      if (wasNewlyDispatched) {
        state.lastDispatchAt = new Date();
        // Arm the notification — fire on this poll if DEST is already
        // populated, or on the first subsequent poll once SAN fills it.
        // Cleared the moment we actually send so a long dispatched dwell
        // doesn't spam (and we never re-fire if state machine drops back
        // through 'dispatched' from at_terminal mid-trip).
        state.dispatchNotifyPending = true;
      }
      next = isCarryover ? 'in_queue' : 'dispatched';

      // Strict policy: only fire when SAN has assigned a terminal in the
      // DEST column. A notification without a terminal isn't actionable —
      // the driver wouldn't know where to go, defeating the 25-min window.
      const terminal = dispatchedDest.get(vn) ?? null;
      // Remember the DEST so a later requeue can be attributed to a terminal even
      // if the driver is never spotted on the T1/T2 page (the 'timeout' path).
      if (terminal) state.dispatchTerminal = terminal;
      if (state.dispatchNotifyPending && terminal) {
        state.dispatchNotifyPending = false;
        Driver.findById(driverId)
          .then((driver) => {
            if (!driver) return;
            return dispatchNotify.notifyDispatch({
              driverId,
              driverName:    driver.name,
              vehicleNumber: state.vehicleNumber,
              // Telnyx compliance — SMS only goes to drivers who explicitly
              // opted in at signup (or via the account-settings toggle).
              // Pushing phone=null here makes notifyDispatch skip the SMS
              // branch but still fire any registered push subscriptions.
              phone:         driver.sms_opt_in ? (driver.phone || null) : null,
              terminal,
            });
          })
          .catch((err) => console.warn(`[Monitor] dispatch notify for #${state.vehicleNumber} failed:`, err.message));
      }
    } else if (inWaiting) {
      // Record actual landing position whenever we see a fired driver in the
      // queue with a pending tracking row — independent of hasBeenSeen, which
      // _runBot already flips to true on success. Gating on hasBeenSeen used to
      // mean successful bot fires NEVER landed their actual_position (the bot
      // set hasBeenSeen=true before the next poll could observe the entry),
      // so every successful fire showed up as "pending" in the admin UI.
      // pendingTrackingId is the single-shot guard: cleared before awaiting
      // to prevent a second poll racing this update.
      if (state.pendingTrackingId && livePosition) {
        const trackingId = state.pendingTrackingId;
        state.pendingTrackingId = null;
        state.landedPositionToday = livePosition; // freeze — currentPosition decays after landing
        PositionTracking.updateActualPosition(trackingId, livePosition)
          .then(() => console.log(`[PosTracking] #${state.vehicleNumber} landed at ${livePosition} (target was recorded)`))
          .catch((err) => console.error('[PosTracking] Failed to update actual position:', err.message));
      }
      // Re-protect: a leftover that left the queue (debounce cleared the flag) or
      // came back after a restart, and is now seen in V Holding again before it
      // fired today, is re-tagged carryover so the scheduler holds it instead of
      // skipping it as "already in queue" (the released-too-late case). Once it
      // fires fresh (positionFiredToday) this no longer applies and a real entry
      // marks it seen normally.
      if (carryoverProtected && !state.inQueueFromCarryover) {
        state.inQueueFromCarryover = true;
        next = 'in_queue';
        console.log(`[Monitor] #${state.vehicleNumber} — leftover re-appeared in V Holding, re-protected as carryover`);
      }
      markSeen();
      state.lastSeenAt = new Date();
      // Seen in V Holding again → reset the carryover-cleared debounce counter:
      // a flicker that briefly hid this leftover doesn't count toward clearing.
      state.carryoverAbsentPolls = 0;
      // If transitioning from at_terminal → in_queue, SAN auto-returned the driver
      // to V Holding before the terminal poll could detect they'd left. Collect for
      // requeue below (after the stateChanged broadcast fires) so we don't double-emit.
      if (prev === 'at_terminal') {
        returnedFromTerminal.push({ driverId, state });
      }
      next = 'in_queue';
    } else if (isCarryover) {
      // Driver was carryover and is no longer in V Holding — SAN's overnight
      // purge may have cleared them. DEBOUNCE: require CARRYOVER_CLEAR_POLLS
      // consecutive absences before believing it. SAN's V Holding list flickers
      // around the midnight refresh, and a single missed poll used to flip a
      // still-queued leftover to "fresh today" — which mislabelled it, let it
      // drain to the front, and get no-show-dispatched (the #0187 chain). Only
      // clear once we've confirmed it's really gone; until then stay carryover.
      const step = carryoverClearStep(state.carryoverAbsentPolls);
      state.carryoverAbsentPolls = step.absentPolls;
      if (step.clear) {
        state.inQueueFromCarryover = false;
        console.log(`[Monitor] #${state.vehicleNumber} — SAN cleared overnight carryover (confirmed gone over ${CARRYOVER_CLEAR_POLLS} polls), armed for fresh schedule`);
        next = 'watching';
      }
      // else: not yet confirmed gone — leave next = prev (stay carryover/in_queue).
    } else if (state.hasBeenSeen) {
      // Driver was seen in V Holding but is no longer there — they've been
      // dispatched to a terminal. Enter at_terminal and let the terminal poll
      // below decide when to requeue.
      if (prev !== 'at_terminal') {
        state.lastGoneAt         = new Date();
        state.atTerminalSince    = new Date();
        state.terminalSeen       = false;
        state.terminalCheckCount = 0;
        state.terminalName       = null;
        state.terminalPosition   = null;
      }
      next = 'at_terminal';
    }
    // !hasBeenSeen + not found → stay 'watching' (not yet queued today)

    const posChanged   = livePosition !== null && livePosition !== state._lastBroadcastPos;
    const stateChanged = next !== prev;

    if (stateChanged) {
      state.state = next;
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} ${prev} → ${next}${livePosition ? ` (pos #${livePosition})` : ''}`);
    } else if (posChanged) {
      // Position changed but state didn't — broadcast update so UI stays accurate
      state._lastBroadcastPos = livePosition;
      broadcast('driver_state', { driverId, state: snap(state) });
      console.log(`[Monitor] #${state.vehicleNumber} pos → #${livePosition} (${state.state})`);
    }
  }

  // ─── Requeue drivers SAN auto-returned to V Holding during terminal service ──
  // When a driver finishes a terminal trip, SAN sometimes places them back in
  // V Holding before our next poll detects their absence from T1/T2. The V Holding
  // loop above flags them; we fire the bot here (after the stateChanged broadcast)
  // so the event is logged and the UI shows the re-queue attempt.
  for (const { driverId, state } of returnedFromTerminal) {
    if (!isWithinOperatingHours()) {
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — outside operating hours ` +
        `(${OP_START_HOUR}:00–${OP_END_HOUR}:00 PT), requeue paused`,
      );
    } else if (!state.isActive) {
      // Driver was deactivated mid-session. Don't requeue — they're no longer
      // participating. isActive is synced immediately on deactivation and again
      // every AUTO_REFRESH_MS so the window where a stale true value lingers is ≤ 5 min.
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — driver inactive, skipping requeue`,
      );
    } else if (hasTodayPositionTarget(state) === false) {
      // Driver has a per-day position schedule and today is disabled. Returning from
      // terminal on an off-day should not put them back in queue — the day is off.
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — today disabled in position schedule, skipping requeue`,
      );
    } else if (
      // Same defer-to-position-scheduler logic as the cleared-terminal block.
      (state.scheduledPosition || state.dayPositions)
      && !state.positionFiredToday
      && isWithinPositionHours()
    ) {
      console.log(
        `[Monitor] #${state.vehicleNumber} returned from terminal — deferring requeue ` +
        `(position scheduler hasn't decided yet today)`,
      );
    } else {
      console.log(
        `[Monitor] #${state.vehicleNumber} at_terminal → in_queue (SAN auto-returned, ` +
        `pos #${state.currentPosition}) — firing requeue`,
      );
      recordTerminalMetric(state, 'san_auto_returned');
      triggerRequeue(driverId, state).catch(console.error);
    }
  }

  // ─── Terminal poll ────────────────────────────────────────────────────────
  // Fetch T1 + T2 in parallel — only when at least one driver is at_terminal.
  // Cost is zero when no drivers are waiting to clear a terminal.
  const atTerminalDrivers = [...watches.entries()]
    .filter(([, s]) => s.state === 'at_terminal');

  if (atTerminalDrivers.length > 0) {
    let t1Vehicles = new Set();
    let t2Vehicles = new Set();

    const [t1Result, t2Result] = await Promise.allSettled([
      fetchPage(T1_URL).then((r) => r.text()),
      fetchPage(T2_URL).then((r) => r.text()),
    ]);

    if (t1Result.status === 'fulfilled') {
      t1Vehicles = parseTerminalPage(t1Result.value);
    } else {
      console.warn(`[Monitor] T1 fetch failed: ${t1Result.reason?.message}`);
    }
    if (t2Result.status === 'fulfilled') {
      t2Vehicles = parseTerminalPage(t2Result.value);
    } else {
      console.warn(`[Monitor] T2 fetch failed: ${t2Result.reason?.message}`);
    }

    for (const [driverId, state] of atTerminalDrivers) {
      if (state.state === 'requeuing') continue;

      const vn            = state.vehicleNorm;
      const t1Pos         = t1Vehicles.get(vn) ?? null;
      const t2Pos         = t2Vehicles.get(vn) ?? null;
      const onAnyTerminal = t1Pos !== null || t2Pos !== null;

      if (onAnyTerminal) {
        const which    = t1Pos !== null ? 'T1' : 'T2';
        const termPos  = t1Pos ?? t2Pos;
        const changed  = !state.terminalSeen
          || state.terminalName !== which
          || state.terminalPosition !== termPos;

        state.terminalSeen      = true;
        state.terminalName      = which;
        state.terminalPosition  = termPos;
        state.terminalLastSeenAt = new Date(); // for detection-lag metric

        if (changed) {
          console.log(`[Monitor] #${state.vehicleNumber} → at ${which} terminal (pos #${termPos})`);
          broadcast('driver_state', { driverId, state: snap(state) });
        }
        // No notification here — dispatch alerts fire earlier, at the
        // waiting → dispatched transition (line ~1431). By the time the
        // driver shows up on a terminal page, the 25-minute window has
        // already been ticking and the notification would be too late.
      } else {
        // Not found on either terminal this poll
        state.terminalCheckCount++;

        const clearedAfterSeen  = state.terminalSeen;
        const timedOut          = state.terminalCheckCount >= MAX_TERMINAL_CHECKS;

        if (clearedAfterSeen || timedOut) {
          if (!isWithinOperatingHours()) {
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — outside operating hours ` +
              `(${OP_START_HOUR}:00–${OP_END_HOUR}:00 PT), requeue paused`,
            );
          } else if (!state.isActive) {
            // Driver deactivated — do not re-add them.
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — driver inactive, skipping requeue`,
            );
          } else if (hasTodayPositionTarget(state) === false) {
            // Per-day schedule: driver has explicitly disabled today. Clearing
            // terminal on an off-day should not put them back in queue.
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — today disabled in position schedule, skipping requeue`,
            );
          } else if (
            // Defer to position scheduler: if this driver has a position target
            // and the scheduler hasn't reached a decision yet today, let it
            // decide first. Otherwise the monitor would land them at whatever
            // low position exists at 5 AM, robbing the scheduler of the chance
            // to fire at the actual target window later in the morning.
            //
            // The scheduler always marks positionFiredToday=true on 'fire', so
            // this defer ALWAYS releases — either when the scheduler fires for
            // this driver, or naturally when position hours end
            // (isWithinPositionHours becomes false).
            (state.scheduledPosition || state.dayPositions)
            && !state.positionFiredToday
            && isWithinPositionHours()
          ) {
            console.log(
              `[Monitor] #${state.vehicleNumber} cleared terminal — deferring requeue ` +
              `(position scheduler hasn't decided yet today)`,
            );
          } else if (state.consecutiveAlreadyQueued >= MAX_CONSECUTIVE_ALREADY_QUEUED) {
            // Runaway guard. The bot has reported "already in queue" this many
            // times in a row but our poll never sees the driver — strong signal
            // the V Holding key doesn't match (padding/data issue). Stop the
            // requeue cycle for the day; admin will see the warning and can fix
            // the underlying mismatch. Cleared on any real add or midnight reset.
            if (!state.requeueBlockedReason) {
              state.requeueBlockedReason = 'consecutive_already_queued';
              console.warn(
                `[Monitor] ⚠️  #${state.vehicleNumber} — bot reported "already in queue" ` +
                `${state.consecutiveAlreadyQueued}× in a row but poll never sees the driver. ` +
                `Suspected V Holding key mismatch (e.g. SAN canonical "0${state.vehicleNumber}" vs DB "${state.vehicleNumber}"). ` +
                `Auto-requeue disabled until next real add or midnight reset.`,
              );
            }
          } else {
            const reason = clearedAfterSeen
              ? 'left terminal list'
              : `not seen on terminals after ${MAX_TERMINAL_CHECKS} checks`;
            console.log(`[Monitor] #${state.vehicleNumber} → ${reason} — requeueing now`);
            recordTerminalMetric(state, clearedAfterSeen ? 'left_terminal' : 'timeout');
            // No delay: driver has fully cleared both V Holding and terminal
            triggerRequeue(driverId, state).catch(console.error);
          }
        } else {
          console.log(
            `[Monitor] #${state.vehicleNumber} not on terminals yet ` +
            `(check ${state.terminalCheckCount}/${MAX_TERMINAL_CHECKS})`,
          );
        }
      }
    }
  }

  // ─── Position schedule check ─────────────────────────────────────────────────
  // Only runs within the position operating window (3 AM–11 PM PT).
  // positionFiredToday is set synchronously before enqueuing — so if 10 drivers all
  // share the same target, each gets triggered exactly once even within this loop.
  // positionFiredToday also survives queue resets: once fired it stays true for
  // the rest of the day regardless of what happens to the queue.
  //
  // Dynamic lead using real poll age + bot execution time (both in seconds).
  // horizonSeconds = how far into the future we need to predict queue size:
  //   pollAgeSeconds   — data already stale by this many seconds when we read it
  //   botExecutionEstimateMs() — rolling P95 of recent bot runs (cold-start: POS_BOT_EXEC_MS)
  //   SAFETY_BUFFER_SECS — extra cushion against under-prediction
  // estimatedDrift = rate(drivers/sec) × horizonSeconds → positions added during that window.
  // biasCorrection  — median of recent (actual - target) landing errors from position_tracking.
  //   If positive (we keep landing too far back), the prediction is bumped up so the bot fires earlier.
  // POS_DRIFT_FLOOR (5) provides a small cushion on near-zero-growth mornings without fabricating
  //   growth that isn't there. Burst-aware effectiveBotExecMs handles the concurrency-contention case
  //   (a bot waiting behind N others in the JobQueue has a longer effective horizon).
  if (isWithinPositionHours()) {
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const DAY_KEY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const todayDayKey = DAY_KEY_MAP[todayDayStr];

  const pollAgeSeconds = lastObservationAt ? (Date.now() - lastObservationAt) / 1000 : POLL_INTERVAL_MS / 1000;
  const botExecMs      = botExecutionEstimateMs();

  // Burst-aware effective bot latency: when multiple bots are already running
  // or pending in the JobQueue, this bot will wait behind them before its own
  // ~botExecMs of work starts. Inflate the per-driver projection accordingly.
  // Formula matches actual queueing: ceil((alreadyInFlight + 1) / concurrency)
  // batches of botExecMs each, e.g. 5 bots already in flight, concurrency 3
  // → this bot is in the 2nd batch → effective wait = 2 × botExecMs.
  const inflightBots         = jobQueue.activeCount + jobQueue.pendingCount;
  const burstBatchPosition   = Math.ceil((inflightBots + 1) / Math.max(1, jobQueue.concurrency));
  const effectiveBotExecMs   = botExecMs * burstBatchPosition;

  // During burst window, drop the SAFETY_BUFFER from the horizon.
  //
  // The SAFETY_BUFFER (10 s) was added to protect against slow-growth mornings
  // where the queue creeps along at 0.5/s — adding 5 extra "buffer" positions
  // keeps us from landing right at target when variability is high.
  //
  // During the burst (rate ≥ 1 driver/s) the buffer has the OPPOSITE effect:
  //   horizon = pollAge(5s) + botExec(4s) + buffer(10s) = 19 s
  //   drift   = 2.23/s × 19s = 42  →  projection hugely over-estimated
  //   result  = driver fires 25-40 positions too early, OR is judged as
  //             "missed_impossible" when it still has a viable window.
  //
  // Without the buffer at burst rate (2.23/s):
  //   horizon = 5 + 4 = 9 s
  //   drift   = 2.23 × 9 = 20  →  accurate: queue grows ~20 between decision and join
  //
  // The ±10 target cannot be achieved while SAFETY_BUFFER inflates burst drift 3×.
  const inBurstWindow  = isWithinBurstWindow();
  const safetyBufferS  = inBurstWindow ? 0 : SAFETY_BUFFER_SECS;
  // SAN commit latency (decision → slot stamped) — the storm-day blind spot the
  // bot-run-time horizon above cannot see (see COMMIT_LATENCY_LEAD). Folded in
  // only when the flag is ON; the estimate is 0 until we have enough fresh
  // samples, so this is a no-op on any morning without measured stalls. It never
  // relaxes the ±10 contract — the lead it feeds is still clamped by POS_MAX_LEAD
  // and growthLeadCap downstream, so on a full storm it is already pinned and on
  // moderate mornings it only corrects an under-predicted horizon.
  const commitLatencyS = COMMIT_LATENCY_LEAD ? commitLatencyEstimateMs() / 1000 : 0;
  const horizonSeconds = pollAgeSeconds + (effectiveBotExecMs / 1000) + commitLatencyS + safetyBufferS;

  // During burst, a single-tick spike (e.g. 75 drivers join in 1–5 s) pushes
  // the measured growth rate to 15–75/s. Raw: drift = 75 × 15 s = 1 125 →
  // every driver instantly gets missed_impossible before any bot can fire.
  //
  // Cap the rate used FOR DRIFT MATH ONLY to BURST_DRIFT_RATE_CAP (3.0/s).
  // The uncapped effectiveGrowthRate still drives secsToFire (fire timing) so
  // the bot still fires at the right moment — we just don't let the drift
  // estimate explode and falsely rule out drivers that still have valid windows.
  //
  // 3.0/s ≈ sustained burst plateau observed across Jun 03–06 data.
  // After a spike tick the smoothed rate returns to 1–2/s within a few ticks,
  // so this cap only bites on the one or two ticks immediately after the jump.
  const driftRate      = inBurstWindow
    ? Math.min(effectiveGrowthRate, BURST_DRIFT_RATE_CAP)
    : effectiveGrowthRate;
  const estimatedDrift = Math.max(POS_DRIFT_FLOOR, Math.ceil(driftRate * horizonSeconds));

  // Storm-onset tracker — advanced exactly once per tick, shared by every
  // per-driver decision below. Transition logs make shadow mornings auditable.
  let onsetBoost = 0;
  if (ONSET_FIRE_LIVE || ONSET_FIRE_SHADOW) {
    const wasActive = onsetState.active;
    onsetState = onsetStep(onsetState, { queue: waitingCount, rate: effectiveGrowthRate });
    if (onsetState.active !== wasActive) {
      console.log(onsetState.active
        ? `[Pos] ⚡ storm ONSET detected (queue ${waitingCount}, rate ${effectiveGrowthRate.toFixed(2)}/s, ` +
          `step +${onsetState.stepSeen}) — early fire ${ONSET_FIRE_LIVE ? 'ACTIVE' : 'SHADOW (log-only)'}, ` +
          `cap ${onsetCapNow(onsetState)} of ${ONSET_CAP} (scales with observed step size)`
        : `[Pos] storm onset cleared (queue ${waitingCount}, rate ${effectiveGrowthRate.toFixed(2)}/s) — early fire disarmed`);
      if (!onsetState.active) lastLoggedOnsetCap = 0;
    }
    // Backlog boost — deepens the cap (≤ ONSET_CAP_MAX) only while unprocessed
    // fires prove SAN's pipe is deep. Logged when the effective cap moves ≥5.
    const bb = onsetBacklogBoost(onsetState);
    onsetBoost = bb.boost;
    const capInForce = onsetCapNow(onsetState, onsetBoost);
    if (onsetState.active && Math.abs(capInForce - lastLoggedOnsetCap) >= 5) {
      console.log(`[Pos] onset cap → ${capInForce} ` +
        `(backlog boost ${Math.round(bb.boost)}: display ${bb.slope10.toFixed(1)}/s × ` +
        `${bb.visAgeS.toFixed(1)}s unprocessed-fire age, max ${ONSET_CAP_MAX})`);
      lastLoggedOnsetCap = capInForce;
    }
  }

  // Context shared by every per-driver decision. Pure data — no module state.
  // isLockedOut is injected so evaluatePositionScheduler stays a pure function
  // (no singleton coupling) — tests can pass their own predicate.
  const decisionCtx = {
    waitingCount,
    effectiveGrowthRate,
    estimatedDrift,
    biasCorrection,
    horizonSeconds,
    botExecMs,
    todayDayKey,
    botSamplesCount:         botLatencySamples.length,
    queueShrinkageDetected,
    isLockedOut:             credentialLockout.isLockedOut,
    inBurstWindow,
    onsetActive:             onsetState.active,
    onsetCap:                onsetCapNow(onsetState, onsetBoost),
    // Predictive-lead inputs (see PREDICTIVE_LEAD). Fleet-wide per tick; the
    // botService require is cached and guarded so decision-only tests (which
    // pass their own ctx) never pull in Playwright.
    observedVelocity:        observedVelocity(Date.now()),
    seedRise:                sustainedRise(Date.now()),
    currentInflight:         (() => { try { return require('./botService').currentInflight(); } catch { return 0; } })(),
    // Pre-onset ladder window (MONITOR_LADDER): burst window AND past the
    // wall-clock floor. Computed once per tick — same clock as prearm.
    ladderWindowOpen:        inBurstWindow && currentMinutesPT() >= LADDER_AFTER_MIN,
    seedWindowOpen:          inBurstWindow && currentMinutesPT() >= LADDER_SEED_AFTER_MIN,
    // Proactive-seed window (MONITOR_LADDER_PROACTIVE): open in the burst window
    // past _AFTER; frac ramps 0→1 from _AFTER to _PEAK (the historical storm
    // time), scaling the allowed seed depth by the clock.
    proactiveOpen:           (LADDER_PROACTIVE_LIVE || LADDER_PROACTIVE_SHADOW)
                               && inBurstWindow && currentMinutesPT() >= LADDER_PROACTIVE_AFTER_MIN,
    // Depth ramp 0→1 from _AFTER to _PEAK by the clock — UNLESS _FULL, which
    // opens the full scoped budget the moment the window opens (front-loaded
    // chain; see LADDER_PROACTIVE_FULL). frac only ever SCALES the seed depth;
    // it never bypasses the per-target scoped budget or the storm/velocity gate.
    proactiveFrac:           LADDER_PROACTIVE_FULL ? 1 : Math.min(1, Math.max(0,
                               (currentMinutesPT() - LADDER_PROACTIVE_AFTER_MIN) /
                               Math.max(1, LADDER_PROACTIVE_PEAK_MIN - LADDER_PROACTIVE_AFTER_MIN))),
  };

  // Track the soonest fire across all armed drivers — drives adaptive polling.
  let minSecondsUntilFire = Infinity;
  // True once any driver this tick is still pending a morning fire (firing now,
  // fire in flight, or genuinely waiting on queue growth). Goes false only when
  // every driver is terminal for the day — fired, missed, no-target, or a
  // carryover awaiting purge. Drives the "morning done → drop 1 s polling back to
  // the normal rate" cadence release below.
  let positionFirePending = false;

  // Drivers who should hold a pre-armed fire session (collected from 'wait'
  // decisions below, reconciled with botService after the loop).
  const prearmWanted = [];

  // Fire decisions collected across the loop and launched together, sorted by
  // target ascending. SAN assigns slots in click-arrival order, so within a
  // same-tick batch of k fires OUR OWN adds spread landings +1…+k across our
  // drivers — in whatever order the watches Map happens to iterate. Sorting by
  // target hands the earliest slots to the lowest (most-overdue) targets — the
  // assignment that minimizes total |landing − target| (rearrangement
  // inequality). No stagger: initiation order alone orders the WS frames, and
  // any deliberate delay would cost real positions during a 20+/s burst.
  const fireBatch = [];
  // Ladder fires dispatched this tick (MONITOR_LADDER): serialized to
  // LADDER_TICK_MAX so the chain climbs at SAN's accurate-commit pace and its
  // display motion stays below every storm trigger. A deferred driver simply
  // stays 'watching' and re-evaluates next tick with the queue already risen
  // by this tick's commits.
  let ladderFiresThisTick = 0;

  // Still-waiting drivers collected for the tick-pipe pass (MONITOR_TICK_PIPE_LEAD):
  // after the loop they are re-evaluated with this tick's fire batch counted
  // into inflight — see runTickPipePass.
  const tickPipeWaiters = [];
  // Ladder seed candidates this tick (MONITOR_LADDER_SEED_GAP) — see
  // runLadderSeedPass. At most one is promoted per stalled tick.
  const seedWaiters = [];
  // Proactive-shadow-only candidates (in the funnel via the proactive depth but
  // not fire-allowed) — logged by runLadderSeedShadowPass, never fired.
  const shadowSeedWaiters = [];

  // Borrowed-probe candidates: waiting drivers whose target is still far above
  // the tail (safe to lend as probes). Collected here, reconciled after the loop.
  const borrowCandidates = [];

  // ── Dynamic fleet prearm signal ──────────────────────────────────────────
  // The day's EARLIEST still-unfired target and when the queue is projected to
  // reach it. Drives prearm (below): the whole fleet arms as soon as the queue
  // is genuinely MOVING, or that earliest fire is within PREARM_LEAD_SECS —
  // never for the idle stretches. Fired drivers are excluded so the plateau (all
  // targets already reached) contributes no earliest target and prearms nothing.
  let earliestTargetToday = Infinity;
  for (const [, s] of watches) {
    if (s.isActive === false || s.borrowedAsProbe || s.positionFiredToday) continue;
    const t = resolveTargetPosition(s, todayDayKey);
    if (typeof t === 'number' && t > 0 && t < earliestTargetToday) earliestTargetToday = t;
  }
  const { stormBuilding } = computeStormReadiness({
    onsetActive:    onsetState.active,
    growthRate:     effectiveGrowthRate,
    earliestTarget: earliestTargetToday,
    waitingCount,
    leadSecs:       PREARM_LEAD_SECS,
  });
  // Smart mode: dynamic signal OR the 03:30 PT wall-clock floor (window-bounded)
  // — deterministic "armed by" guarantee; the clock only ever arms EARLIER.
  // Fail-safe: with SMART_CADENCE off, revert prearm to the pre-change rule —
  // every waiting driver arms across the whole burst window.
  const prearmReady = computePrearmReady({
    smart:         SMART_CADENCE,
    stormBuilding,
    inWatchWindow: inBurstWindow,
    minutesPT:     currentMinutesPT(),
    clockMinutes:  PREARM_CLOCK_MIN,
  });

  for (const [driverId, state] of watches) {
    // A driver currently lent to the tail probe is "checked out": don't fire,
    // prearm, or time them. They resume normal scheduling the instant they're
    // retired (borrowedAsProbe cleared, with BORROW_MARGIN positions of runway
    // before their real fire point — see MONITOR_BORROW_PROBE).
    if (state.borrowedAsProbe) continue;

    // Per-driver guard: one driver's evaluation throwing must never affect the
    // others. Critical since fires are BATCHED (fireBatch launches after this
    // loop): an unguarded throw here would strand already-collected fires with
    // positionFiredToday=true — those drivers would never fire that day.
    // (Pre-batching, a throw "only" skipped the remaining drivers' evaluations
    // — also wrong, just less catastrophic.)
    try {
    const decision = evaluatePositionScheduler(state, decisionCtx);

    if (Number.isFinite(decision.secondsUntilFire) && decision.secondsUntilFire < minSecondsUntilFire) {
      minSecondsUntilFire = decision.secondsUntilFire;
    }

    // Any driver still firing, mid-fire, or genuinely waiting on queue growth
    // keeps the morning "live" (carryover-purge waiters don't — they fire on the
    // purge, not on queue growth). Same eligibility as prearm.
    if (
      decision.action === 'fire' ||
      decision.action === 'skip_bot_inflight' ||
      (decision.action === 'wait' && decision.reason !== 'awaiting_overnight_purge')
    ) {
      positionFirePending = true;
    }

    // Apply side effects per decision action
    switch (decision.action) {
      case 'skip_no_target':
        // Driver has no position target today (e.g. day_positions[todayDayKey] is null).
        // Mark positionFiredToday=true so the monitor's defer-to-position-scheduler
        // condition releases. Otherwise the monitor would defer forever on this
        // driver's terminal-cleared events, never requeueing them.
        state.positionFiredToday = true;
        break;

      case 'skip_already_fired':
        console.log(decision.logLine);
        maybeFlagUnderRescue(state, decision.metrics?.targetPosition, waitingCount, effectiveGrowthRate);
        break;

      case 'skip_locked_out':
        // Same handling as a 'wait' decision — log + record decision row so the
        // admin can see why the scheduler isn't firing. We deliberately do NOT
        // set positionFiredToday: if the admin updates the SAN password and
        // clears the lockout mid-day, the next poll evaluates this driver
        // normally and may fire at the target later.
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        break;

      case 'skip_bot_inflight':
      case 'wait':
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);

        // Pre-arm candidates: drivers genuinely waiting on queue growth
        // (NOT carryovers — they're still inside V Holding, so arming would
        // just park on the WAIT screen). queue_shrinking waiters are included:
        // the purge settles within a poll or two and they fire right after.
        // Any one trigger suffices:
        //   • stormBuilding — the fleet-wide dynamic signal: queue moving, or the
        //     day's earliest target within the 20-min lead (replaces the old
        //     "whole burst window" rule so we don't hold sessions warm all idle);
        //   • this driver's own projected fire is near (PREARM_AHEAD_SECS);
        //   • the queue has reached the position-locked storm zone
        //     (PREARM_QUEUE_POS) — a backstop for a chunk storm that invalidates
        //     the rate-based estimate in one tick.
        if (
          decision.action === 'wait' &&
          decision.reason !== 'awaiting_overnight_purge' &&
          (prearmReady ||
            decision.secondsUntilFire <= PREARM_AHEAD_SECS ||
            waitingCount >= PREARM_QUEUE_POS)
        ) {
          prearmWanted.push({
            driverId,
            vehicleNumber:    state.vehicleNumber,
            secondsUntilFire: decision.secondsUntilFire,
            // Credentials are fetched + decrypted only if an arm actually
            // happens (botService skips already-armed / cooling-down drivers).
            getCredentials: async () => {
              const d = await Driver.findByIdWithCredentials(driverId);
              if (!d?.san_username || !d?.san_password) return null;
              return { sanUsername: d.san_username, sanPassword: decrypt(d.san_password) };
            },
          });
        }

        // Tick-pipe candidate: still genuinely waiting this tick — re-evaluated
        // after the loop with the same-tick fire batch counted into inflight.
        if (
          TICK_PIPE_LEAD &&
          decision.action === 'wait' &&
          decision.reason !== 'awaiting_overnight_purge'
        ) {
          tickPipeWaiters.push({
            driverId,
            state,
            target: decision.metrics?.targetPosition ?? Infinity,
          });
        }

        // Ladder seed candidate (MONITOR_LADDER_SEED_GAP): flagged by the
        // decision itself; promoted (at most one) by runLadderSeedPass below.
        // Fire-allowed candidates → seedWaiters (live); proactive-shadow-only
        // candidates → shadowSeedWaiters (log-only).
        if (decision.action === 'wait' && decision.seedCandidate) {
          const entry = {
            driverId,
            state,
            target: decision.metrics?.targetPosition ?? Infinity,
            effQ: decision.effectiveQueueAtDecision,
          };
          if (decision.seedCanFire) seedWaiters.push(entry);
          else if (decision.seedProactiveOnly) shadowSeedWaiters.push(entry);
        }

        // Borrowed-probe candidate: a genuinely-waiting driver whose real fire is
        // still far enough away — by the rate-aware retire buffer — that we can
        // ALWAYS hand them back and re-arm before it. Never carryovers (already
        // in V Holding). borrowSafeToHold is the per-driver storm-safety gate
        // (see the 07-04 note): a driver drops out the instant the queue climbs
        // within the runway, and tailProbeService retires them there.
        if (BORROW_PROBE_ENABLED) {
          const target = decision.metrics?.targetPosition ?? null;
          if (
            target !== null &&
            decision.reason !== 'awaiting_overnight_purge' &&
            !state.hasBeenSeen &&
            (target - waitingCount) >= BORROW_PROBE_MARGIN &&
            borrowSafeToHold(target, waitingCount, effectiveGrowthRate)
          ) {
            borrowCandidates.push({
              driverId,
              vehicle:    state.vehicleNumber,
              target,
              // preferred workhorse floats to the front of the roster
              preferred:  String(state.vehicleNumber) === BORROW_PROBE_VEHICLE,
            });
          }
        }
        break;

      case 'skip_already_seen': {
        // Driver is already visible in V Holding. Check whether they joined
        // significantly early (manual join before the burst window).
        const livePos = state.currentPosition;
        const target  = decision.metrics?.targetPosition ?? null;
        // "Early join" = driver is in queue more than 30 positions ahead of
        // their target. Threshold of 30 lets normal ±20 bias variance pass
        // while catching the real problem: joining at pos 2 when target is 121.
        const isEarlyJoin = (
          target  != null &&
          livePos != null &&
          livePos < (target - 30)
        );

        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, {
          ...decision.metrics,
          earlyJoinPosition: isEarlyJoin ? livePos : null,
        });

        if (isEarlyJoin) {
          // Record first detection timestamp + position (once per early-join episode)
          if (!state.earlyJoinDetectedAt) {
            state.earlyJoinDetectedAt = new Date();
            state.earlyJoinAtPosition = livePos;
          }

          // AUTO-REARM: treat the driver exactly like an overnight carryover.
          // Setting inQueueFromCarryover=true + hasBeenSeen=false tells the
          // existing carryover machinery to:
          //   1. Hold the position scheduler (→ wait, awaiting_overnight_purge)
          //      while the driver is still in V Holding at the wrong position.
          //   2. Arm them for a fresh fire the moment they leave V Holding —
          //      the carryover flag clears and state→watching/hasBeenSeen=false,
          //      so the burst-window scheduler evaluates them normally and fires
          //      the bot at the correct queue depth.
          // Only set if carryover isn't already active from a previous cycle.
          if (!state.inQueueFromCarryover) {
            state.inQueueFromCarryover = true;
            state.wasCarryoverToday    = true; // treat exactly like an overnight carryover
            state.hasBeenSeen          = false;
            console.warn(
              `[Pos] ⚠️  #${state.vehicleNumber} early-join auto-rearm ` +
              `(pos ${livePos}, target ${target}). ` +
              `Tagged as carryover — will fire once driver leaves queue.`,
            );
          }
          // positionFiredToday stays false — scheduler remains live
        } else {
          // Driver is in queue at or near their target. Day's work is done.
          state.positionFiredToday = true;
        }
        break;
      }

      case 'fire':
        // Ladder serialization (see ladderFiresThisTick above): over-cap ladder
        // fires defer to the next tick without marking the driver fired.
        if (decision.reason === 'ladder_fire') {
          if (ladderFiresThisTick >= LADDER_TICK_MAX) {
            console.log(`[Pos] #${state.vehicleNumber} — 🪜 ladder deferred to next tick (cap ${LADDER_TICK_MAX}/tick)`);
            break;
          }
          ladderFiresThisTick++;
          ladderLastFireMs = Date.now();
          ladderAddsCommitted++; // our own add — excluded from the growth signal
        }
        console.log(decision.logLine);
        state.positionFiredToday = true; // mark before enqueuing — prevents double-trigger
        // Collected, not triggered: same-tick fires are launched together after
        // the loop, sorted by target (see fireBatch below).
        fireBatch.push({ driverId, state, decision });
        break;

      case 'place_anyway': {
        // Overshoot rail with MONITOR_PLACE_ANYWAY on: rather than leave the
        // driver out of the queue, fire best-effort. resolvePlaceAnyway decides
        // fire-vs-fall-back from the live armed state (see the helper for the
        // warm/cold rules and why warm never cold-fires).
        const routing = resolvePlaceAnyway(decision, hasArmedFireSession(driverId));
        if (!routing.fire) {
          const miss = routing.miss;
          console.log(miss.logLine);
          recordPositionDecision(state, miss.action, miss.reason, miss.metrics);
          state.positionFiredToday = true;
          break;
        }
        console.log(`${decision.logLine} [${routing.warm ? 'warm' : 'cold'}]`);
        state.positionFiredToday = true; // mark before enqueuing — prevents double-trigger
        fireBatch.push({ driverId, state, decision });
        break;
      }

      case 'missed_impossible':
        // Queue is already past max — firing now would land far above max.
        // Record the row for visibility and mark fired so the monitor's
        // defer-to-position-scheduler condition releases (otherwise we'd be
        // stuck waiting forever on this driver).
        console.log(decision.logLine);
        recordPositionDecision(state, decision.action, decision.reason, decision.metrics);
        state.positionFiredToday = true;
        break;

      default:
        console.warn(`[Pos] Unknown decision action: ${decision.action}`);
    }
    } catch (err) {
      console.error(`[Pos] evaluation failed for #${state.vehicleNumber}: ${err.message} — other drivers unaffected`);
    }
  }

  // ─── Tick-pipe pass: count the same-tick batch into the lead ──────────────
  // Only engages when this tick actually fired something (a leap tick). Fires
  // it adds join fireBatch before the sort, so the batch still launches in
  // target order with the added fires exactly where their targets place them.
  runTickPipePass(fireBatch, tickPipeWaiters, decisionCtx);

  // ─── Ladder seed pass: break a pre-onset stall the gap-11 chain can't ─────
  const seededThisTick = runLadderSeedPass(fireBatch, seedWaiters, decisionCtx, ladderFiresThisTick);
  // Proactive-shadow pass (log-only): only when nothing actually fired/seeded.
  if (seededThisTick === 0 && ladderFiresThisTick === 0) {
    runLadderSeedShadowPass(shadowSeedWaiters);
  }

  // ─── Launch this tick's fires, most-overdue target first ──────────────────
  // triggerPositionSchedule claims the armed session in its first synchronous
  // slice (before any await), so every claim below still lands ahead of this
  // tick's syncFireSessions call — the disarm-race guarantee is unchanged;
  // only the initiation ORDER within the batch is new.
  if (fireBatch.length > 0) {
    fireBatch.sort((a, b) =>
      (a.decision.effectivePosition ?? Infinity) - (b.decision.effectivePosition ?? Infinity));

    const launch = ({ driverId, state, decision }) =>
      triggerPositionSchedule(driverId, state, decision.effectivePosition, decision.fireOpts)
        .catch(console.error);

    if (FIRE_PACING_MODE === 'off') {
      for (const item of fireBatch) launch(item);
    } else {
      // Pacing gate (shadow or on). Plan against live inflight + queue depth.
      let inflight = 0;
      try { inflight = require('./botService').currentInflight(); } catch { /* no armed pool */ }
      const targets = fireBatch.map((it) => it.decision.effectivePosition ?? Infinity);
      const { releases, fired, held, urgent, engaged } = planFirePacing(targets, inflight, waitingCount);

      fireBatch.forEach((item, i) => {
        if (FIRE_PACING_MODE === 'shadow') {
          // Observe only: launch EVERYTHING unchanged (releases[] is a pure
          // projection); zero behaviour change.
          launch(item);
        } else if (releases[i]) {
          launch(item);
        } else {
          // ON + held: undo the fire mark so the scheduler re-evaluates the
          // driver next ~1 s poll (its armed session stays parked — still in the
          // pre-arm wanted set). planFirePacing guarantees a no-runway driver is
          // never held, so this never fires late past its window.
          item.state.positionFiredToday = false;
          console.log(`[Pace] ⏸ #${item.state.vehicleNumber} held (inflight ${inflight}, cap ${PACE_MAX_INFLIGHT}, target ${targets[i]}, queue ${waitingCount}) — retry next tick`);
        }
      });

      const pacedPeak   = Math.min(PACE_MAX_INFLIGHT, inflight + fired) + urgent;
      const unpacedPeak = inflight + fireBatch.length;
      console.log(`[Pace] ${FIRE_PACING_MODE.toUpperCase()} — batch ${fireBatch.length}, inflight ${inflight} (cap ${PACE_MAX_INFLIGHT}): `
        + `${engaged ? `ENGAGED fire ${fired} / hold ${held}${urgent ? ` (urgent-release ${urgent})` : ''}` : `not engaged (would hold <${PACE_MIN_HOLD}) — all ${fireBatch.length} fire`}; `
        + `est peak inflight paced ~${pacedPeak} vs unpaced ~${unpacedPeak} → est drift ~${paceDriftEst(pacedPeak)} vs ~${paceDriftEst(unpacedPeak)}`);
    }
  }

  // ─── Pre-arm reconciliation ────────────────────────────────────────────────
  // Declarative: hand botService the full wanted set every tick and let it
  // converge (arm missing, refresh stale, disarm dropped). Fire-and-forget —
  // arming takes ~4 s and must never block the 1 s burst poll. All throttling
  // (in-flight dedup, failure cooldowns, ARMED_MAX memory cap) lives inside
  // botService.syncFireSessions, so calling it every tick is safe.
  if (PREARM_ENABLED) {
    try {
      // A tick-pipe fire can promote a driver out of this tick's wanted set
      // after it was collected (wait → fire in the same tick) — drop them so
      // sync doesn't re-arm a session the launch just claimed.
      const stillWanted = prearmWanted.filter(
        (w) => !watches.get(w.driverId)?.positionFiredToday,
      );
      require('./botService').syncFireSessions(stillWanted)
        .catch((err) => console.error('[Arm] sync failed:', err.message));
    } catch (err) {
      console.error('[Arm] botService unavailable:', err.message);
    }
  }

  // ─── Sacrificial tail probe (MONITOR_TAIL_PROBE=1, default off) ────────────
  // Declarative, same pattern as the pre-armer: tell the probe every tick
  // whether it should be running. Active only in the storm zone (burst window,
  // queue at/past the position-locked onset, position fires still pending) —
  // its exact tail samples feed recordFleetLanding → the fleet-probe effective
  // queue + event-driven nudge, giving the scheduler intra-chunk observations
  // the ~5 s stepped display can never show. See tailProbeService for rails.
  if (TAIL_PROBE_ENABLED) {
    try {
      require('./tailProbeService').sync({
        active: inBurstWindow
          && waitingCount >= PREARM_QUEUE_POS
          && prearmWanted.length > 0
          // imminence gate: some pending fire within TAIL_PROBE_AHEAD_SECS —
          // keeps calm mornings from burning the cycle cap (see const above)
          && Number.isFinite(minSecondsUntilFire)
          && minSecondsUntilFire <= TAIL_PROBE_AHEAD_SECS,
        dayKey:          todayDayKey,
        watchedVehicles: new Set([...watches.values()].map((s) => String(s.vehicleNumber))),
        onTailSample:    (pos) => recordFleetLanding(pos),
      });
    } catch (err) {
      console.error('[TailProbe] unavailable:', err.message);
    }
  }

  // ─── Borrowed tail probe (MONITOR_BORROW_PROBE=1, default off) ─────────────
  // No dedicated account? Lend the probe the highest-target waiting drivers.
  // Same activation gate as the dedicated probe. Fire-and-forget: creds are
  // fetched/decrypted for the ≤BORROW_PROBE_MAX chosen drivers, the roster is
  // handed to tailProbeService (which converges — starts new, retires dropped),
  // and each driver's borrowedAsProbe flag is reconciled from the probe's ACTUAL
  // held set so a retiring driver stays checked-out until truly removed.
  if (BORROW_PROBE_ENABLED) {
    // STORM-WINDOW borrowing (2026-07-22), made safe PER-DRIVER: the candidate
    // list above already contains ONLY drivers with provable hand-back runway
    // (borrowSafeToHold, the rate-aware +buffer). As the queue climbs, drivers
    // drop out of the list one by one exactly when the storm gets within their
    // runway → tailProbeService retires them (server-verified remove) → the
    // prearm pool re-arms → they fire their own target on time. So this feeds
    // the probe THROUGH the storm using only far-target drivers, instead of the
    // old all-or-nothing calm gate. The outer kill (borrowAllowedInCalm, now
    // widened) only trips on a fleet-wide berserk rate as a last-resort stop.
    const borrowActive = borrowAllowedInCalm(waitingCount, effectiveGrowthRate);
    if (!borrowActive && borrowHistory.size > 0 && !_borrowRetireLogged) {
      _borrowRetireLogged = true;
      console.log(`[Borrow] emergency global stop (queue ${waitingCount}, rate ${effectiveGrowthRate.toFixed(1)}/s) — retiring all borrowed drivers`);
    }
    if (borrowActive) _borrowRetireLogged = false;
    updateBorrowRoster(borrowCandidates, todayDayKey, borrowActive)
      .catch((err) => console.error('[Borrow] roster sync failed:', err.message));
  }

  // Set the adaptive interval for the next scheduled poll.
  //
  // Inside the storm-watch window (3:00–8:00 AM PT) we lock to POLL_BURST_MS (1 s)
  // — but ONLY while the queue is actually active. The 1 s cadence is what keeps a
  // burst catchable (at 5 s the queue can jump 50 positions in one tick, skipping a
  // 40-wide target window whole; the Jun 05 relaxation to 30 s here cost 10
  // drivers), so we drop to it the instant anything stirs: onset armed, any
  // measurable growth, the queue climbing into storm range, or a fire imminent —
  // all well before the ramp. Through the genuinely flat calm and the post-storm
  // plateau we idle at BURST_IDLE_POLL_MS (5 s — still far tighter than the old
  // out-of-window relaxation), so a 5-hour window is not 5 hours of 1 s SAN hits.
  // A nearer scheduled fire can still pull the idle cadence faster than the floor.
  // "Active" = the queue is MOVING (or a fire is imminent) — not merely sitting
  // high. An absolute-level test would keep us at 1 s through the whole post-storm
  // plateau (queue parked at ~270 with nothing left to fire); growth rate and an
  // imminent fire are the true ramp signals and both fall silent on the plateau.
  //
  // And once the morning's fires are ALL done — the highest (last) target has
  // fired, or every driver is otherwise terminal (fired / missed / no-target /
  // carryover awaiting purge) — there is nothing left to catch, so we leave the
  // watch window's fast cadence entirely and fall back to the normal adaptive
  // rate even though the clock is still inside the window. This drops the
  // post-firing SAN polling from the 5 s idle floor to the full idle interval for
  // the rest of the morning (the plateau can run hours). It re-tightens on its
  // own the moment a fire becomes pending again (a requeue, a carryover leaving,
  // a target edit) — positionFirePending flips back true next tick.
  const inWatchWindow = inBurstWindow; // reuse the tick's single timezone read
  const queueActive   = isQueueActive({
    onsetActive:         onsetState.active,
    growthRate:          effectiveGrowthRate,
    minSecondsUntilFire,
  });
  const adaptiveMs = expectedNextPollMs(minSecondsUntilFire);
  const newDelayMs = computePollDelayMs({
    smart:       SMART_CADENCE,
    inWatchWindow,
    firePending: positionFirePending,
    queueActive,
    burstMs:     POLL_BURST_MS,
    idleMs:      BURST_IDLE_POLL_MS,
    adaptiveMs,
  });
  if (newDelayMs !== currentPollDelayMs) {
    const reason = !SMART_CADENCE
      ? (inWatchWindow ? 'burst window lock (fail-safe: smart cadence OFF)' : 'adaptive')
      : (inWatchWindow && positionFirePending)
        ? (queueActive ? 'storm-watch: queue active (1 s)' : 'storm-watch: idle')
        : inWatchWindow
          ? 'storm-watch: morning firing complete → normal cadence'
          : `nearest fire in ${Number.isFinite(minSecondsUntilFire) ? minSecondsUntilFire.toFixed(0) + 's' : '∞'}`;
    console.log(`[Monitor] Poll cadence ${currentPollDelayMs/1000}s → ${newDelayMs/1000}s (${reason})`);
    currentPollDelayMs = newDelayMs;
  }
  } else {
    if (currentPollDelayMs !== POLL_INTERVAL_MS) {
      // Outside position hours (e.g. midnight–2 AM PT) → relax cadence.
      console.log(`[Monitor] Poll cadence ${currentPollDelayMs/1000}s → ${POLL_INTERVAL_MS/1000}s (outside position hours)`);
      currentPollDelayMs = POLL_INTERVAL_MS;
    }
    // Defensive sweep: no fire can happen outside position hours, so no page
    // should stay parked (each one holds a Chromium context). No-op when
    // nothing is armed — cheap to call every tick.
    if (PREARM_ENABLED) {
      try {
        require('./botService').disarmAllFireSessions('outside position hours')
          .catch((err) => console.error('[Arm] disarm sweep failed:', err.message));
      } catch { /* botService unavailable — nothing armed either */ }
    }
  } // end isWithinPositionHours
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a single driver to the watch list.
 * isAuto = true → auto-managed (active driver); false → manual watch.
 * Bootstraps hasBeenSeen from today's logs to preserve context on restart.
 */
// _ctx is an optional pre-loaded batch context from Log.loadTodayContext().
// When provided, all three per-driver DB queries are skipped — Map lookups only.
async function addWatch(driverId, { isAuto = false, _ctx = null } = {}) {
  if (watches.has(driverId)) {
    const existing = watches.get(driverId);
    if (isAuto) {
      existing.isAuto = true;
      autoDriverIds.add(driverId);
    } else {
      // Manual add of an already-watched (auto) driver — pin it to Monitor page.
      // Re-emit watch_added so the Monitor page card appears even though the
      // driver is already in the watches Map from auto-loading.
      manualWatchIds.add(driverId);
      broadcast('watch_added', { driverId, state: snap(existing) });
    }
    return snap(existing);
  }

  const driver = _ctx?.driverById?.get(driverId) ?? await Driver.findById(driverId);
  if (!driver) throw new Error(`Driver ${driverId} not found`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // lastAddLog = the latest ADD-type log today. hasBeenSeen is derived ONLY from
  // this — a REMOVE-type success (carryover_cleanup / manual_remove) must never be
  // read back as "the driver is in queue" (the 2026-06-15 restart bug, where a
  // midnight carryover-removal success restored hasBeenSeen=true and the scheduler
  // skipped the whole fleet as "already in queue").
  let lastAddLog, requeueCountToday, positionFiredToday, wasCarryoverToday;
  if (_ctx) {
    lastAddLog          = _ctx.latestAddByDriver.get(driverId) ?? null;
    requeueCountToday   = _ctx.requeueCountByDriver.get(driverId) ?? 0;
    const hasPosSched   = !!(driver.scheduled_position || driver.day_positions);
    positionFiredToday  = hasPosSched ? !!_ctx.positionLogByDriver.get(driverId) : false;
    wasCarryoverToday   = _ctx.carryoverByDriver.has(driverId);
  } else {
    lastAddLog = await Log.findTodayLatestAdd(driverId, today);
    const todayLogs   = await Log.findTodayMonitorRequeues(driverId, today);
    requeueCountToday = todayLogs ? parseInt(todayLogs.count, 10) : 0;
    const hasPosSched = !!(driver.scheduled_position || driver.day_positions);
    const positionLog = hasPosSched
      ? await Log.findTodayByTriggerType(driverId, 'position_schedule', today)
      : null;
    positionFiredToday = !!positionLog;
    wasCarryoverToday  = await Log.wasCarryoverToday(driverId, today);
  }

  const hasBeenSeen = !!(lastAddLog && ['success', 'already_queued'].includes(lastAddLog.status));
  // Rebuild carryover protection after a restart. A driver flagged a leftover at
  // today's midnight (durable marker) that we have NOT yet fired or re-added is
  // still carryover — restore the flag so the scheduler waits for SAN to drop
  // them and fires fresh at target, instead of the next poll mislabelling them
  // "already in queue". If we already fired/added them today, they're legitimately
  // ours and not carryover.
  const inQueueFromCarryover = wasCarryoverToday && !hasBeenSeen && !positionFiredToday;

  const state = {
    driverId,
    driverName:        driver.name,
    vehicleNumber:     driver.vehicle_number,
    vehicleNorm:       norm(driver.vehicle_number),
    isAuto,
    state:             (hasBeenSeen || inQueueFromCarryover) ? 'in_queue' : 'watching',
    hasBeenSeen,
    addedAt:           new Date(),
    lastSeenAt:        null,
    lastDispatchAt:    null,
    lastGoneAt:        null,
    lastRequeuedAt:    null,
    lastResult:        null,
    requeueCount:       0,
    requeueCountToday,
    consecutiveAlreadyQueued: 0,   // runaway-loop guard — see _handleBotResult
    requeueBlockedReason:     null, // set when guard trips; cleared on a real add/dispatch
    isActive:                driver.is_active ?? true,   // snapshot; kept current by refreshAutoWatches
    scheduledPosition:       driver.scheduled_position ?? null,
    dayPositions:            driver.day_positions ?? null,
    maxAcceptablePosition:   driver.max_acceptable_position ?? null, // null → default to target + 40
    manuallyRemovedAt:       driver.manually_removed_at ?? null,
    positionFiredToday,
    inQueueFromCarryover,      // true at midnight reset for leftovers + rebuilt here on restart
    wasCarryoverToday,         // durable day-scoped leftover flag (survives debounce clear + restart)
    carryoverAbsentPolls: 0,   // debounce: consecutive polls a carryover driver is absent from V Holding
    currentPosition:    null,  // live position updated every poll tick
    lastPosition:       null,  // position bot placed them at (from bot result)
    atTerminalSince:    null,
    terminalSeen:       false,
    terminalCheckCount: 0,
    terminalName:       null,
    terminalPosition:   null,
    dispatchTerminal:   null,  // DEST (T1/T2) captured at dispatch — attributes timeout requeues
    terminalLastSeenAt: null,  // last poll this driver was seen on a terminal page
    earlyJoinDetectedAt: null, // first time we detected driver in queue far ahead of target
    earlyJoinAtPosition: null, // their queue position at that first detection
    dispatchNotifyPending: false, // armed on entering 'dispatched'; fires when DEST is known
    _lastBroadcastPos:  null,  // internal: avoids redundant SSE on same position
    _lastQueueSize:     null,  // internal: queue size at last poll (for logging)
    borrowedAsProbe:    false, // true while lent to the tail probe (MONITOR_BORROW_PROBE)
  };

  watches.set(driverId, state);
  if (isAuto)  autoDriverIds.add(driverId);
  else         manualWatchIds.add(driverId);

  broadcast('watch_added', { driverId, state: snap(state) });
  console.log(`[Monitor] Watching #${driver.vehicle_number} (id=${driverId}, auto=${isAuto}, hasBeenSeen=${hasBeenSeen}, carryover=${inQueueFromCarryover})`);

  return snap(state);
}

/**
 * Stop watching a driver — the admin "Stop Watching" action.
 *
 * Fully removes the driver from the monitor: clears BOTH the manual pin and the
 * auto-watch and deletes the in-memory state, so the bot stops servicing them
 * immediately. Previously an auto-watched (active) driver was only unpinned and
 * kept in `watches`, so "Stop Watching" removed the Monitor card but the bot
 * kept running — the button appeared to do nothing.
 *
 * For an active subscriber, the periodic refreshAutoWatches will legitimately
 * re-add them within AUTO_REFRESH_MS (that's the paid service resuming). To keep
 * a driver stopped, lock (past_due) or deactivate them — the refresh gate then
 * keeps them out permanently.
 */
function removeWatch(driverId) {
  const state = watches.get(driverId);
  if (!state) return false;

  watches.delete(driverId);
  autoDriverIds.delete(driverId);
  manualWatchIds.delete(driverId);
  broadcast('watch_removed', { driverId, vehicleNumber: state.vehicleNumber });
  console.log(`[Monitor] Stopped watching #${state.vehicleNumber}`);
  return true;
}

/**
 * Called by driverController.removeFromQueue after a manual-remove bot succeeds.
 * Resets the driver's in-memory state so:
 *   • monitor doesn't try to auto-requeue them (hasBeenSeen=false → at_terminal
 *     transition never fires)
 *   • position scheduler doesn't fire for them again today (positionFiredToday=true)
 *   • driver can still manually trigger via "Get Back in Queue" — that path
 *     bypasses both checks
 *
 * If the driver isn't currently being watched (rare — possible if they were
 * deactivated mid-removal), this is a no-op.
 */
function markManuallyRemoved(driverId) {
  const state = watches.get(driverId);
  if (!state) {
    console.warn(`[Monitor] markManuallyRemoved: driver ${driverId} not in watches`);
    return false;
  }

  state.hasBeenSeen        = false;
  state.state              = 'watching';
  state.positionFiredToday = true;
  state.terminalSeen       = false;
  state.terminalCheckCount = 0;
  state.terminalName       = null;
  state.terminalPosition   = null;
  state.atTerminalSince    = null;
  state.manuallyRemovedAt  = new Date();

  console.log(`[Monitor] #${state.vehicleNumber} marked manually-removed — auto-requeue suppressed for today`);
  broadcast('driver_state', { driverId, state: snap(state) });
  return true;
}

/**
 * Re-arms EVERY watched driver for today's position schedule. Called once
 * per day from the poll loop when the position window opens (3 AM PT) and
 * also exposed for unit tests + the rare ops case where an admin wants to
 * force a re-arm across the fleet.
 *
 * Why this matters: the midnight reset clears `requeueCountToday` and tags
 * carryover drivers, but it does NOT undo `hasBeenSeen` / `positionFiredToday`
 * that get set during 00:00-03:00 if a driver runs the bot manually. Without
 * this 3 AM re-arm, that early run silently blocks the position scheduler
 * from firing at the real target later in the morning.
 *
 * For each driver:
 *   • Drivers observably in V Holding / dispatched / at terminal are tagged
 *     inQueueFromCarryover so the scheduler waits for them to be dropped
 *     before re-firing (same machinery as the midnight-carryover handling).
 *   • Drivers not in queue get a fully clean slate.
 *   • Drivers in 'requeuing' state aren't touched — the bot they're running
 *     will finish on its own.
 *
 * Returns the number of drivers re-armed.
 */
function armPositionWindowForToday(dayKey = todayPT) {
  let armed = 0;
  for (const s of watches.values()) {
    // "Observably queued" means SAN is currently tracking them in some form,
    // OR we've previously observed them in V Holding this session.
    const isObservablyQueued =
      s.state === 'in_queue' ||
      s.state === 'dispatched' ||
      s.state === 'at_terminal' ||
      s.hasBeenSeen === true;

    s.inQueueFromCarryover = isObservablyQueued;
    s.wasCarryoverToday    = isObservablyQueued; // re-arm treats a currently-queued driver as a leftover
    s.hasBeenSeen          = false;
    s.positionFiredToday   = false;
    s.lastPosDecision      = null;
    s.pendingTrackingId    = null;
    s.manuallyRemovedAt    = null;
    s.terminalSeen         = false;
    s.terminalCheckCount   = 0;
    s.terminalName         = null;
    s.terminalPosition     = null;
    s.atTerminalSince      = null;
    s.earlyJoinDetectedAt  = null;
    s.earlyJoinAtPosition  = null;
    s.dispatchNotifyPending = false;

    // Don't yank state out from under an in-flight bot.
    if (s.state !== 'requeuing') {
      s.state = s.inQueueFromCarryover ? 'in_queue' : 'watching';
    }
    armed++;
  }

  if (armed > 0) {
    console.log(`[Monitor] Position window armed (${POS_START_HOUR}:00 PT, day ${dayKey}) — ${armed} driver(s) ready for today's schedule`);
    broadcast('position_window_opened', { date: dayKey, armed });
  }
  return armed;
}

/**
 * Re-arms the position scheduler for a single driver. Used by the admin
 * "🎯 Arm" button and the allow-refire endpoint.
 *
 * This is the single-driver equivalent of armPositionWindowForToday() and
 * applies the identical policy: drivers currently observably in the queue
 * are tagged inQueueFromCarryover so the position scheduler waits for them
 * to leave V Holding (via dispatch OR SAN's overnight clear-out) before
 * re-firing at the real target. No need to remove them manually first —
 * the carryover machinery handles it.
 */
function allowRefireToday(driverId) {
  const state = watches.get(driverId);
  if (!state) {
    console.warn(`[Monitor] allowRefireToday: driver ${driverId} not in watches`);
    return false;
  }

  // Same observation check armPositionWindowForToday uses — keeps the two
  // entry points behaviorally identical so an admin clicking "Arm" gets the
  // same outcome as the 3 AM auto-arm would have produced.
  const isObservablyQueued =
    state.state === 'in_queue' ||
    state.state === 'dispatched' ||
    state.state === 'at_terminal' ||
    state.hasBeenSeen === true;

  state.inQueueFromCarryover = isObservablyQueued;
  state.wasCarryoverToday    = isObservablyQueued; // re-arm treats a currently-queued driver as a leftover
  state.hasBeenSeen          = false;
  state.positionFiredToday   = false;
  state.manuallyRemovedAt    = null;
  state.lastPosDecision      = null;
  state.pendingTrackingId    = null;
  state.terminalSeen         = false;
  state.terminalCheckCount   = 0;
  state.terminalName         = null;
  state.terminalPosition     = null;
  state.atTerminalSince      = null;
  state.earlyJoinDetectedAt  = null;
  state.earlyJoinAtPosition  = null;
  state.dispatchNotifyPending = false;

  // Don't yank state out from under an in-flight bot.
  if (state.state !== 'requeuing') {
    state.state = state.inQueueFromCarryover ? 'in_queue' : 'watching';
  }

  console.log(`[Monitor] #${state.vehicleNumber} → position scheduler re-armed for today (carryover=${state.inQueueFromCarryover})`);
  broadcast('driver_state', { driverId, state: snap(state) });
  return true;
}

/**
 * Auto-watch ALL currently active drivers.
 * Called once on startup; also re-called by refreshAutoWatches().
 */
async function watchAllActive() {
  const drivers = await Driver.findAllActive();
  if (!drivers.length) return 0;

  // Batch-load today's log context for all drivers in 3 parallel queries
  // instead of 3 × N sequential queries. Cuts startup from O(N) round-trips
  // down to O(1) regardless of driver count.
  const today      = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const newIds     = drivers.filter((d) => !watches.has(d.id)).map((d) => d.id);
  const logCtx     = await Log.loadTodayContext(newIds, today);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const ctx        = { ...logCtx, driverById };

  let added = 0;
  for (const d of drivers) {
    if (!watches.has(d.id)) {
      await addWatch(d.id, { isAuto: true, _ctx: ctx }).catch((e) =>
        console.warn(`[Monitor] Skip auto-watch for #${d.vehicle_number}:`, e.message),
      );
      added++;
    }
    // Restore manual Monitor-page pin from DB (survives server restarts).
    // monitor_enabled is set true when admin clicks "Watch Vehicle".
    if (d.monitor_enabled && !manualWatchIds.has(d.id)) {
      manualWatchIds.add(d.id);
      console.log(`[Monitor] Restored manual pin for #${d.vehicle_number}`);
    }
  }
  return added;
}

/**
 * Sync a watch's vehicle identity after the driver record's vehicle_number
 * changed (cab handover / renumbering). The watch snapshots vehicleNumber at
 * addWatch and every observation (positions, terminal state, hasBeenSeen) is
 * ABOUT that cab — so when the number changes, the old observations describe a
 * different physical vehicle and must be dropped, or the dashboard keeps
 * live-tracking the OLD cab (2026-07-13: record #35 was renumbered 0034→0026
 * mid-flight; the driver's card streamed cab 0034 through V Holding and T2 all
 * day while his real cab sat 400 positions back).
 *
 * Leaves scheduling flags (positionFiredToday, wasCarryoverToday) alone: they
 * are day-scoped facts about the DRIVER's service, not the cab, and resetting
 * them could double-fire a target. A bot mid-run ('requeuing') keeps its state
 * label so _handleBotResult can settle it; everything cab-derived still resets.
 *
 * Returns true when a change was applied.
 */
function syncWatchVehicle(state, vehicleNumber) {
  const newNorm = norm(vehicleNumber);
  if (newNorm === state.vehicleNorm) return false;

  console.log(
    `[Monitor] #${state.vehicleNumber} → #${vehicleNumber} — vehicle number changed ` +
    `(id=${state.driverId}), dropping observations of the old cab`,
  );

  state.vehicleNumber = vehicleNumber;
  state.vehicleNorm   = newNorm;

  // Everything below was observed under the OLD vehicle number.
  if (state.state !== 'requeuing') state.state = 'watching';
  state.hasBeenSeen          = false;
  state.currentPosition      = null;
  state.lastPosition         = null;
  state.landedPositionToday  = null;
  state.pendingTrackingId    = null;   // never attach the new cab's landing to an old fire
  state.atTerminalSince      = null;
  state.terminalSeen         = false;
  state.terminalCheckCount   = 0;
  state.terminalName         = null;
  state.terminalPosition     = null;
  state.terminalLastSeenAt   = null;
  state.dispatchTerminal     = null;
  state.dispatchNotifyPending = false;
  state.inQueueFromCarryover = false;
  state.carryoverAbsentPolls = 0;
  state.redzoneRemovePending = false;
  state.earlyJoinDetectedAt  = null;
  state.earlyJoinAtPosition  = null;
  state._lastBroadcastPos    = null;

  return true;
}

/**
 * Periodic sync: pick up newly activated drivers, remove deactivated ones.
 * Runs every AUTO_REFRESH_MS (default 5 min) so new drivers are auto-added
 * without a server restart.
 */
async function refreshAutoWatches() {
  try {
    const drivers   = await Driver.findAllActive();
    const activeIds = new Set(drivers.map((d) => d.id));

    // Add any new active drivers; update scheduling fields for existing ones
    let added = 0;
    for (const d of drivers) {
      if (!watches.has(d.id)) {
        await addWatch(d.id, { isAuto: true }).catch((e) =>
          console.warn(`[Monitor] Refresh skip #${d.vehicle_number}:`, e.message),
        );
        added++;
      } else {
        // Sync schedule + active fields so profile changes take effect within 5 min
        const existing = watches.get(d.id);
        existing.isActive              = d.is_active ?? true;
        existing.scheduledPosition     = d.scheduled_position ?? null;
        existing.dayPositions          = d.day_positions ?? null;
        existing.maxAcceptablePosition = d.max_acceptable_position ?? null;
        // Cab handover / renumbering: re-point the watch at the new vehicle and
        // drop observations of the old cab (they describe a different vehicle).
        if (syncWatchVehicle(existing, d.vehicle_number)) {
          broadcast('driver_state', { driverId: d.id, state: snap(existing) });
        }
      }
    }

    // Evict every watched driver who is no longer serviceable. findAllActive
    // (subscription_status ∈ active/trialing AND is_active) is AUTHORITATIVE — a
    // manual Monitor-page pin must NOT keep the bot running for a driver whose
    // subscription lapsed (past_due/canceled) or who was deactivated. Otherwise a
    // pin silently bypasses the billing lock (a past_due driver kept being
    // serviced because monitor_enabled=true). So we sweep ALL watches, not just
    // auto ones, and clear both flags together.
    let removed = 0;
    for (const driverId of [...watches.keys()]) {
      if (!activeIds.has(driverId)) {
        const s = watches.get(driverId);
        watches.delete(driverId);
        autoDriverIds.delete(driverId);
        manualWatchIds.delete(driverId);
        if (s) broadcast('watch_removed', { driverId, vehicleNumber: s.vehicleNumber });
        removed++;
      }
    }

    if (added || removed) {
      console.log(`[Monitor] Auto-refresh: +${added} added, -${removed} removed (${watches.size} total)`);
    }
  } catch (e) {
    console.warn('[Monitor] Auto-refresh failed:', e.message);
  }
}

/**
 * Manually trigger the bot for a watched driver (the "Run" button).
 * Works regardless of current queue state.
 */
async function manualRun(driverId) {
  const state = watches.get(driverId);
  if (!state) throw new Error('Driver not in watch list');
  if (state.state === 'requeuing') throw new Error('Bot is already running for this driver');

  console.log(`[Monitor] Manual run triggered for #${state.vehicleNumber}`);
  return triggerRequeue(driverId, state);
}

/** Current snapshot — returned to new SSE clients and REST callers. */
function getState() {
  return {
    pollStats:        lastPollStats,
    pollIntervalMs:   currentPollDelayMs, // live adaptive interval (idle ≤ this ≤ near-fire)
    pollIntervalIdleMs: POLL_INTERVAL_MS, // configured idle ceiling, for UI display
    queueUrl:         QUEUE_URL,
    watches:          [...watches.values()].map(snap),
    recentEvents:     recentRequeuEvents.slice(),
    jobQueue: {
      active:  jobQueue.activeCount,
      pending: jobQueue.pendingCount,
    },
    operatingHours: {
      active:     isWithinOperatingHours(),
      startHour:  OP_START_HOUR,
      endHour:    OP_END_HOUR,
    },
    proxy: proxyHealth.getState(),
  };
}

/** Aggregate stats snapshot (for the Watchlist stats bar). */
function getStats() {
  const all = [...watches.values()];
  return {
    total:             all.length,
    watching:          all.filter((s) => s.state === 'watching').length,
    inQueue:           all.filter((s) => s.state === 'in_queue').length,
    dispatched:        all.filter((s) => s.state === 'dispatched').length,
    atTerminal:        all.filter((s) => s.state === 'at_terminal').length,
    gone:              0,
    requeuing:         all.filter((s) => s.state === 'requeuing').length,
    requeuedToday:     all.reduce((n, s) => n + s.requeueCountToday, 0),
    successToday:      all.filter((s) => s.lastResult?.success && s.requeueCountToday > 0).length,
    jobQueue: {
      active:  jobQueue.activeCount,
      pending: jobQueue.pendingCount,
    },
    operatingHours: {
      active:     isWithinOperatingHours(),
      startHour:  OP_START_HOUR,
      endHour:    OP_END_HOUR,
    },
  };
}

/** Register a callback for all monitor events (SSE streams). Returns unsubscribe fn. */
function subscribe(callback) {
  emitter.on('event', callback);
  return () => emitter.off('event', callback);
}

/**
 * Bootstrap on server start:
 *   1. Auto-watch ALL active drivers.
 *   2. Start the poll interval.
 *   3. Start the auto-refresh interval (picks up new drivers every 5 min).
 *   4. Fire one immediate poll so the UI has data right away.
 */
// Reconcile the in-memory "position window armed" flag after a restart.
//
// positionWindowArmedForDate is in-memory and lost on restart, so the next poll
// would re-run armPositionWindowForToday() — which wipes positionFiredToday/
// hasBeenSeen and re-tags any driver currently in queue as inQueueFromCarryover.
// Drivers dispatched on a trip after that get routed through the carryover-cleared
// path with no requeue (the 2026-06-09 #0187 incident: fired at 04:37, restart at
// 08:29 re-tagged as carryover, dispatch at 10:34 logged "SAN cleared overnight
// carryover" with no triggerRequeue, driver had to manually re-add ~1h 53m later).
// So a restart AFTER the window has opened treats DB-restored positionFiredToday/
// hasBeenSeen/inQueueFromCarryover as evidence the window already armed today and
// preserves the flag (skips the re-arm that would wipe reconstructed state).
//
// CLOCK GATE (2026-07-04 fix): a restart BEFORE the window opens must NOT set the
// flag. Carryover markers are stamped at the midnight reset — hours before the
// 3 AM arm — so without this gate an early-morning restart (deploys land in the
// 11:30 PM–2:30 AM window) wrongly concludes "already armed" and skips the 3 AM
// arm AND its forced carryover drop for the whole day. On 2026-07-04 three
// restarts at 00:57–01:15 did exactly that, stranding #0030/#0187/#0305/#0387 on
// SAN's slow passive drop. Before position hours the arm cannot have run yet, so
// we leave the flag untouched and let the real 3 AM arm (and drop) fire.
function reconcileArmStateOnRestart() {
  if (!isWithinPositionHours()) return; // pre-window restart: let the 3 AM arm run

  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const dayAlreadyInProgress = [...watches.values()].some(
    (s) => s.positionFiredToday || s.hasBeenSeen || s.inQueueFromCarryover,
  );
  if (dayAlreadyInProgress) {
    positionWindowArmedForDate = todayKey;
    console.log(`[Monitor] Position window already armed today (${todayKey}) — restart during position hours, preserving driver state`);
  }
}

async function startMonitor() {
  // Auto-watch all active drivers first
  try {
    const added = await watchAllActive();
    console.log(`[Monitor] Auto-watched ${added} active driver(s)`);
  } catch (e) {
    console.warn('[Monitor] Initial auto-watch failed:', e.message);
  }

  // Reconcile the "position window armed" flag after a restart. Clock-gated so a
  // pre-3 AM restart can't skip that day's arm + forced carryover drop — see the
  // reconcileArmStateOnRestart() comment for the 2026-07-04 incident it fixes.
  reconcileArmStateOnRestart();

  if (pollTimer)    { clearTimeout(pollTimer);    pollTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  // Self-rescheduling chain so the adaptive interval (currentPollDelayMs) can
  // change between ticks. .finally() guarantees we wait for the in-flight poll
  // to finish before scheduling the next one — no overlap, no piling up.
  const schedule = () => {
    const delay = nudgePending ? 0 : currentPollDelayMs;
    nudgePending = false;
    pollTimer = setTimeout(() => {
      pollInFlight = true;
      poll()
        .catch(console.error)
        .finally(() => { pollInFlight = false; if (pollTimer !== null) schedule(); });
    }, delay);
  };
  scheduleFn = schedule;
  schedule();

  // Fire-visibility listener: a fired vehicle spotted in V Holding before its
  // WAIT-screen confirm is a genuine landing 5–10 s early — feed the fleet
  // probe now (recordFleetLanding nudges the poll chain itself).
  try {
    require('./botService').setFireVisibilityListener(({ position }) => {
      recordFleetLanding(position);
    });
  } catch (e) {
    console.warn('[Monitor] fire-visibility listener not registered:', e.message);
  }

  refreshTimer = setInterval(() => refreshAutoWatches().catch(console.error), AUTO_REFRESH_MS);

  pollInFlight = true;
  poll().catch(console.error).finally(() => { pollInFlight = false; }); // immediate first tick — doesn't block the chain

  console.log(
    `[Monitor] Started — poll cadence ${POLL_INTERVAL_MS / 1000}s idle / ` +
    `${POLL_NEAR_FIRE_MS / 1000}s near fire / ${POLL_AT_FIRE_MS / 1000}s at fire / ` +
    `${POLL_BURST_MS / 1000}s burst / ${BURST_IDLE_POLL_MS / 1000}s idle ` +
    `(${BURST_START_HOUR}:00–${BURST_END_HOUR}:00 AM PT storm-watch, activity-gated), ` +
    `auto-refresh every ${AUTO_REFRESH_MS / 1000}s, ` +
    `bot concurrency: ${BOT_CONCURRENCY}, ` +
    `watching ${watches.size} driver(s)`,
  );
}

function stopMonitor() {
  if (pollTimer)    { clearTimeout(pollTimer);     pollTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  scheduleFn   = null;   // a stopped monitor can't be nudged back to life
  nudgePending = false;
  pollInFlight = false;
  onsetState   = freshOnsetState();
  lastLoggedOnsetCap = 0;
  try { require('./botService').setFireVisibilityListener(null); } catch { /* not loaded */ }
  // Retire any borrowed probes so no real driver is left mid-cycle in the live
  // queue (syncRoster with active:false stops every loop and force-removes).
  if (BORROW_PROBE_ENABLED) {
    try { require('./tailProbeService').syncRoster({ active: false, roster: [] }); }
    catch (err) { console.error('[Borrow] stop cleanup failed:', err.message); }
  }
  borrowCredsCache.clear();
  borrowPinnedSecondId = null;
  borrowHistory.clear();
  borrowExcluded.clear();
  borrowRosterInFlight = false;
  watches.clear();
  autoDriverIds.clear();
  manualWatchIds.clear();
  prevWaitingCount   = null;
  smoothedGrowthRate = 0;
  lastObservationAt  = null;
  prevObservationAt  = null;
  biasCorrection     = 0;
  biasPollCount      = 0;
  recentObservations.length = 0;
  currentPollDelayMs = POLL_INTERVAL_MS;
  positionWindowArmedForDate = null;
}

/** Seconds until next scheduled poll (uses the current adaptive interval). */
function nextPollIn() { return Math.round(currentPollDelayMs / 1000); }

/**
 * Immediately sync a driver's schedule fields in the in-memory state so that
 * position-scheduler decisions reflect the DB change without waiting for the
 * next AUTO_REFRESH_MS tick (up to 5 minutes).
 *
 * Called by driverController.updateProfile and adminController.updateDriver
 * after a successful schedule update — mirrors the same pattern used by
 * markManuallyRemoved for immediate state propagation.
 *
 * @param {number} driverId
 * @param {{ scheduledPosition, dayPositions, maxAcceptablePosition }} fields
 */
function syncDriverSchedule(driverId, { scheduledPosition, dayPositions, maxAcceptablePosition, isActive } = {}) {
  const state = watches.get(Number(driverId));
  if (!state) return; // driver not currently watched — no-op

  // Capture the target the scheduler was chasing BEFORE we overwrite the fields,
  // so we can tell whether this edit actually moved the day's target position.
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const todayDayKey = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' }[todayDayStr];
  const oldTarget   = resolveTargetPosition(state, todayDayKey);

  state.scheduledPosition     = scheduledPosition     ?? null;
  state.dayPositions          = dayPositions          ?? null;
  state.maxAcceptablePosition = maxAcceptablePosition ?? null;
  if (isActive !== undefined) state.isActive = isActive;

  console.log(`[Monitor] Schedule synced for #${state.vehicleNumber} (immediate, no refresh wait)`);

  // ─── Re-arm after a mid-day target edit that followed a "missed" latch ──────
  // A driver marked missed_impossible sets positionFiredToday=true so the poll
  // loop stops re-evaluating them (see the case at ~3817). But that latch was
  // set against the OLD target. If the admin/driver now edits the target to a
  // DIFFERENT, still-reachable position, the driver must get a fresh shot — the
  // edit alone doesn't clear the latch, so without this they stay skipped as
  // "already fired today" for the rest of the day even though they never landed.
  //
  // 2026-08-23 #4324: target 490 (unreachable, queue peaked ~430) → edited to
  // 299 (already past → missed_impossible, latched) → edited to 428 (reachable),
  // but the 299-miss latch blocked the 428 fire. This releases exactly that.
  //
  // Guarded tightly so a genuine placement is never disturbed:
  //   • target actually changed (a real edit, not a no-op re-save)
  //   • the driver is still latched from a MISS, not a real fire
  //     (lastPosDecision === 'missed_impossible' — a fired driver reads 'fired'
  //      /'waiting'/'completed', and can't have missed after firing since the
  //      latch would have blocked the fire)
  //   • never actually landed (landedPositionToday == null)
  //   • no bot currently in flight (state !== 'requeuing')
  // If the new target is ALSO already past max, allowRefireToday just lets the
  // scheduler re-decide next tick — the past-max guard re-marks it missed with
  // no wasted fire (see evaluatePositionScheduler's waitingCount > max rail).
  const newTarget = resolveTargetPosition(state, todayDayKey);
  const targetChanged = newTarget != null && newTarget !== oldTarget;
  const missLatched   =
    state.positionFiredToday === true &&
    state.lastPosDecision === 'missed_impossible' &&
    state.landedPositionToday == null &&
    state.state !== 'requeuing';

  if (targetChanged && missLatched) {
    console.log(
      `[Monitor] #${state.vehicleNumber} — target changed ${oldTarget} → ${newTarget} after a miss; ` +
      `clearing the missed latch so the scheduler can re-evaluate the new target`,
    );
    allowRefireToday(Number(driverId));
  }
}

/**
 * Returns true if the driver has an active position target for today.
 *
 * Used to gate auto-requeue after terminal clearance: drivers who have
 * explicitly disabled today in their per-day schedule should not be
 * re-added to the queue after a dispatch, just as they aren't added in
 * the morning.
 *
 * Returns null (unconstrained) when the driver has no position schedule at
 * all — time-scheduled drivers are always eligible for auto-requeue.
 */
function hasTodayPositionTarget(state) {
  // No position schedule — driver is time-based; no day restriction applies
  if (!state.scheduledPosition && !state.dayPositions) return null;

  if (state.dayPositions) {
    try {
      const dayKey = { Sun:'0',Mon:'1',Tue:'2',Wed:'3',Thu:'4',Fri:'5',Sat:'6' }[
        new Date().toLocaleDateString('en-US', { weekday:'short', timeZone:'America/Los_Angeles' })
      ];
      const dp = JSON.parse(state.dayPositions);
      return !!(dp[dayKey] ?? null);
    } catch {
      return false; // malformed JSON → treat as disabled to be safe
    }
  }

  // Legacy single scheduledPosition — no per-day restriction
  return !!state.scheduledPosition;
}

/**
 * Returns a diagnostic snapshot for every position-scheduled driver currently
 * being watched. Used by the admin "Early Join Alerts" page.
 *
 * Includes:
 *   - Live queue state and position
 *   - Whether an early-join was detected (manual queue join before burst window)
 *   - Whether the position scheduler is still armed or has been blocked
 *
 * Sorted: critical (blocked) first, then warnings (armed but early-join), then
 * normal (waiting / fired / off day).
 */
function getPositionDiagnostics() {
  const DAY_KEY_MAP = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const todayDayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const todayKey    = DAY_KEY_MAP[todayDayStr];

  const rows = [];

  for (const [driverId, state] of watches.entries()) {
    // Only position-scheduled drivers
    if (!state.scheduledPosition && !state.dayPositions) continue;

    let todayTarget = null;
    if (state.dayPositions) {
      try {
        const dp = JSON.parse(state.dayPositions);
        todayTarget = dp[todayKey] ?? null;
      } catch { todayTarget = null; }
    } else {
      todayTarget = state.scheduledPosition;
    }

    const maxAcceptable = Number.isInteger(state.maxAcceptablePosition)
      ? state.maxAcceptablePosition
      : (todayTarget != null ? todayTarget + 40 : null);

    // Determine scheduler status for display
    let schedulerStatus;
    const earlyJoin = !!state.earlyJoinDetectedAt;

    if (earlyJoin && state.inQueueFromCarryover && !state.positionFiredToday) {
      // Auto-rearm applied: holding as carryover, will fire once driver leaves queue
      schedulerStatus = 'rearmed_waiting';
    } else if (earlyJoin && !state.positionFiredToday) {
      // Early join detected, carryover already cleared, scheduler evaluating normally
      schedulerStatus = 'armed_early_join';
    } else if (earlyJoin && state.positionFiredToday) {
      // Joined early AND eventually positionFiredToday got set (e.g. returned to
      // queue past max). Scheduler done for the day.
      schedulerStatus = 'blocked';
    } else if (state.positionFiredToday) {
      schedulerStatus = 'fired'; // bot ran (or day skipped) — normal completion
    } else if (state.inQueueFromCarryover) {
      schedulerStatus = 'awaiting_carryover';
    } else if (todayTarget === null) {
      schedulerStatus = 'off_day';
    } else {
      schedulerStatus = 'waiting'; // armed, hasn't fired yet
    }

    // Warning level: drives sort order and badge colour
    let warningLevel = 'none';
    if (earlyJoin && state.positionFiredToday) warningLevel = 'critical'; // blocked, nothing to do
    else if (earlyJoin)                         warningLevel = 'warning';  // rearmed/recovering

    const gap = (todayTarget != null && state.earlyJoinAtPosition != null)
      ? todayTarget - state.earlyJoinAtPosition
      : null;

    // Borrowed-probe audit for this driver (if ever lent today).
    const bh = borrowHistory.get(driverId) ?? null;
    // Judge on the FROZEN landing, never currentPosition: a held position only
    // decays after landing (front of queue dispatches), so the live value drifts
    // below target and paints a phantom undershoot (#4004: landed 295/−6 ✓,
    // shown as 282/−19 ✗ within minutes).
    const landedOnTarget = (state.positionFiredToday && todayTarget != null && state.landedPositionToday != null)
      ? Math.abs(state.landedPositionToday - todayTarget) <= 10
      : null;

    rows.push({
      driverId,
      vehicleNumber:        state.vehicleNumber,
      driverName:           state.driverName,
      currentState:         state.state,
      currentPosition:      state.currentPosition,
      todayTarget,
      maxAcceptable,
      positionFiredToday:   state.positionFiredToday,
      inQueueFromCarryover: state.inQueueFromCarryover,
      wasCarryoverToday:    state.wasCarryoverToday,
      hasBeenSeen:          state.hasBeenSeen,
      schedulerStatus,
      warningLevel,
      earlyJoinDetectedAt:  state.earlyJoinDetectedAt,
      earlyJoinAtPosition:  state.earlyJoinAtPosition,
      earlyJoinGap:         gap,
      lastPosDecision:      state.lastPosDecision,
      // Borrowed-probe fields (null/false when never borrowed):
      borrowedNow:          !!state.borrowedAsProbe,
      borrowCycles:         bh?.cycles ?? 0,
      borrowFirstAt:        bh?.firstBorrowedAt ?? null,
      borrowRetiredAt:      bh?.retiredAt ?? null,
      borrowExcluded:       borrowExcluded.has(driverId),
      landedPosition:       state.positionFiredToday ? (state.landedPositionToday ?? null) : null,
      landedOnTarget,
    });
  }

  // Sort: critical first, then warning, then everything else alphabetically
  const priority = { critical: 0, warning: 1, none: 2 };
  rows.sort((a, b) => {
    const pd = (priority[a.warningLevel] ?? 2) - (priority[b.warningLevel] ?? 2);
    if (pd !== 0) return pd;
    return a.vehicleNumber.localeCompare(b.vehicleNumber);
  });

  return rows;
}

module.exports = {
  startMonitor,
  stopMonitor,
  addWatch,
  removeWatch,
  manualRun,
  markManuallyRemoved,
  syncDriverSchedule,
  allowRefireToday,
  rescueBorrowedDriver,
  armPositionWindowForToday,
  // Test-only: returns the live in-memory state object for a driver so tests
  // can mutate flags directly. Do NOT use from production code paths —
  // mutating state outside snap() / broadcast() breaks SSE updates.
  _getInternalState: (driverId) => watches.get(driverId),
  // Test-only: exposes the in-memory armed-for-date flag so restart-guard
  // tests can confirm the guard prevented re-arming.
  _getPositionWindowArmedForDate: () => positionWindowArmedForDate,
  _setPositionWindowArmedForDate: (v) => { positionWindowArmedForDate = v; },
  // Test-only: the clock-gated restart guard extracted from startMonitor().
  _reconcileArmStateOnRestart: reconcileArmStateOnRestart,
  getPositionDiagnostics,
  watchAllActive,
  refreshAutoWatches,
  getState,
  getStats,
  subscribe,
  nextPollIn,
  // Exposed for unit tests
  _parseQueue:                parseQueue,
  _parseTerminalPage:         parseTerminalPage,
  _syncWatchVehicle:          syncWatchVehicle,
  _norm:                      norm,
  _planFirePacing:            planFirePacing,
  _isWithinOperatingHours:    isWithinOperatingHours,
  _evaluatePositionScheduler: evaluatePositionScheduler,
  _resolvePlaceAnyway:        resolvePlaceAnyway,
  // Storm-watch cadence & prearm (pure) — see stormWatchCadence.test.js
  _computeStormReadiness:     computeStormReadiness,
  _computePrearmReady:        computePrearmReady,
  _parsePrearmClockPT:        parsePrearmClockPT,
  _isQueueActive:             isQueueActive,
  _computePollDelayMs:        computePollDelayMs,
  _resolveTargetPosition:     resolveTargetPosition,
  _expectedNextPollMs:        expectedNextPollMs,
  _onsetStep:                 onsetStep,
  _onsetCapNow:               onsetCapNow,
  _runTickPipePass:           runTickPipePass,
  _setLadderLastFireMs:       (ms) => { ladderLastFireMs = ms; },
  _runLadderSeedPass:         runLadderSeedPass,
  _sustainedRise:             sustainedRise,
  _recordSeedQueueObservation: recordSeedQueueObservation,
  _bumpLadderAdds:            (n = 1) => { ladderAddsCommitted += n; },
  _runLadderSeedShadowPass:   runLadderSeedShadowPass,
  _onsetBacklogBoost:         onsetBacklogBoost,
  _maybeFlagUnderRescue:      maybeFlagUnderRescue,
  _carryoverClearStep:        carryoverClearStep,
  _removeCarryoverLeftover:   removeCarryoverLeftover,
  _redzoneRemoveDecision:     _redzoneRemoveDecision,
  _autoRemoveNotAuthorized:   autoRemoveNotAuthorized,
  _dropAndArmLeftover:        dropAndArmLeftover,
  _dropAndArmCarryoverLeftovers: dropAndArmCarryoverLeftovers,
  _setWatch:                  (driverId, state) => watches.set(driverId, state),
  _expectedNextPollMs:        expectedNextPollMs,
  _botExecutionEstimateMs:    botExecutionEstimateMs,
  _recordBotLatency:          recordBotLatency,
  _computeMedian:             computeMedian,
  _normaliseLatencySample:    normaliseLatencySample,
  _resetLatencySamples:       () => { botLatencySamples.length = 0; },
  // SAN commit-latency instrumentation — see commitLatency.test.js
  _recordCommitLatency:       recordCommitLatency,
  _commitLatencyEstimateMs:   commitLatencyEstimateMs,
  _resetCommitLatencySamples: () => { commitLatencySamples.length = 0; },
  _recordFleetLanding:        recordFleetLanding,
  _borrowAllowedInCalm:       borrowAllowedInCalm,
  _borrowRetireBuffer:        borrowRetireBuffer,
  _borrowSafeToHold:          borrowSafeToHold,
  _selectBorrowAccounts:      selectBorrowAccounts,
  _setFleetLanding:           (position, atMs) => { lastFleetLanding = { position, atMs: atMs ?? Date.now() }; },
  _getFleetLanding:           () => ({ ...lastFleetLanding }),
};
