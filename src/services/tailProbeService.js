// ─── Sacrificial tail probe (±10 accuracy — the anti-straddle feed) ───────────
//
// WHY: SAN's spacezone page only changes its waiting count every ~5 s, so a
// competitor chunk of +40–50 looks like one instantaneous leap and any target
// inside it is unobservable — the "chunk-straddle" miss class. But the TRUE
// tail processes joins at ~4–10/s (measured from landing anchors, Jun 26–30
// logs), i.e. a chunk takes 5–8 real seconds during which the tail passes
// through every intermediate value. An ADD always returns the server's own
// slot assignment (WAIT screen = true tail + 1 at process time), immune to any
// display caching (verified 2026-07-03: spacezone serves no-cache/no-store —
// the 5 s step is SAN's own render cadence, so sampling by ADD is the only
// intra-chunk observation channel). So: probe vehicle(s) run add → read
// position → confirm-remove (the two-step flow validated live 2026-06-30 on
// #4007) every few seconds during the storm, feeding exact tail samples to
// the fleet-probe effective queue.
//
// SAMPLING CADENCE IS THE LEVER (5-day replay, pooled): no probe = 82% of
// fires ≤ +15 (worst +32); one vehicle ≈ 3.5 s cycle = 88% ≤ +15 (worst +27);
// two vehicles interleaved ≈ 1.8 s = 94% ≤ +15 (worst +24); three ≈ 1.2 s =
// 96% ≤ +15 (worst +23). MULTIPLE VEHICLES: TAIL_PROBE_VEHICLE /
// _SAN_USERNAME / _SAN_PASSWORD accept comma-separated aligned lists; each
// probe runs its own loop + browser, first cycles staggered by
// TAIL_PROBE_STAGGER_MS × index so samples interleave instead of clumping.
//
// CONTRACT SAFETY: samples are reported as (position − 1) — the tail count
// AFTER our own probe row is removed — so the effective queue stays a strict
// lower bound of the true tail even in the corner where the removal lands
// between sample and a driver's fire. Undershoot ≥ −9 is preserved.
//
// SAN SAFETY RAILS (this thing touches the live queue, so belt AND braces):
//   - default OFF (MONITOR_TAIL_PROBE=1 to enable) + needs dedicated
//     TAIL_PROBE_VEHICLE / TAIL_PROBE_SAN_USERNAME / TAIL_PROBE_SAN_PASSWORD;
//   - runs ONLY while monitorService says so (burst window + storm zone +
//     position fires pending within the imminence gate) — sync() is
//     declarative like the pre-armer;
//   - refuses to run if ANY probe vehicle is a watched (real) driver;
//   - hard daily cycle cap PER PROBE (TAIL_PROBE_MAX_CYCLES, default 150 —
//     total SAN adds/day = cap × number of probes);
//   - after TAIL_PROBE_MAX_FAILURES consecutive failed cycles a probe is
//     disabled for the day AND a last-resort robust removeFromQueue runs so
//     its vehicle can never sit stranded in V Holding. Other probes continue.
//
// NOT YET LIVE-TESTED — before enabling on a storm morning, run one manual
// smoke cycle off-peak per probe account and confirm the [TailProbe] add →
// sample → removed log sequence.

const TAIL_PROBE_ENABLED  = process.env.MONITOR_TAIL_PROBE === '1';
const splitList = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PROBE_VEHICLES      = splitList(process.env.TAIL_PROBE_VEHICLE);
const PROBE_USERNAMES     = splitList(process.env.TAIL_PROBE_SAN_USERNAME);
// Passwords may legitimately contain anything except commas here; documented.
const PROBE_PASSWORDS     = splitList(process.env.TAIL_PROBE_SAN_PASSWORD);
// Pause between cycles — cadence ≈ (pause + cycle work ~2–3 s) / #probes.
const CYCLE_PAUSE_MS      = parseInt(process.env.TAIL_PROBE_CYCLE_PAUSE_MS  ?? '750', 10);
const MAX_CYCLES_PER_DAY  = parseInt(process.env.TAIL_PROBE_MAX_CYCLES      ?? '150', 10);
const MAX_CONSEC_FAILURES = parseInt(process.env.TAIL_PROBE_MAX_FAILURES    ?? '2', 10);
const STEP_TIMEOUT_MS     = parseInt(process.env.TAIL_PROBE_STEP_TIMEOUT_MS ?? '6000', 10);
// First-cycle stagger between probes so their samples interleave (≈ half a
// cycle for 2 probes, a third for 3 — default suits the ~3.5 s single cycle).
const STAGGER_MS          = parseInt(process.env.TAIL_PROBE_STAGGER_MS      ?? '1700', 10);

// Injectable deps: real implementations come from botService/playwright at
// first use; tests replace them via _overrideDeps to drive the state machine
// without a browser.
const deps = {
  chromium: null, // lazy — require('playwright').chromium on first ensureSession
  bot:      null, // lazy — require('./botService')
  sleep:    (ms) => new Promise((r) => setTimeout(r, ms)),
  now:      () => Date.now(),
};
function bot() {
  if (!deps.bot) deps.bot = require('./botService');
  return deps.bot;
}

// Shared (fleet-level) state.
const state = {
  desired:         false,
  dayKey:          null,
  samples:         0,
  lastSamplePos:   null,
  lastSampleAt:    0,
  onTailSample:    null,
  collisionWarned: false,
};

// One record per configured (dedicated) probe vehicle.
const probes = PROBE_VEHICLES.map((vehicle, i) => ({
  index:          i,
  vehicle,
  username:       PROBE_USERNAMES[i] ?? '',
  password:       PROBE_PASSWORDS[i] ?? '',
  running:        false,
  disabledForDay: false,
  cycles:         0,
  consecFailures: 0,
  browser:        null,
  context:        null,
  page:           null,
  parked:         false,
}));

// ─── BORROWED probes (no dedicated account available) ─────────────────────────
// When the operator has no spare SAN account, the monitor lends the probe a
// REAL watched driver whose target is still far above the tail (their own fire
// is many minutes away). Same add→sample→confirm-remove cycle, sourced from a
// dynamic roster the monitor supplies each tick via sync({ roster }). SAFETY:
//   - only drivers the monitor deems far-from-target are ever in the roster
//     (it drops a driver the instant the tail nears their target — see
//     MONITOR_BORROW_PROBE_MARGIN — giving a large dispatch margin AND runway
//     to hand back cleanly);
//   - every cycle ENDS with the vehicle server-verify removed, so between
//     cycles a borrowed driver is never in the queue;
//   - retire (driver dropped from roster) stops the loop, then force-removes
//     if anything is left, BEFORE the monitor fires their real placement;
//   - the monitor suppresses all driver-facing events while borrowed, so the
//     driver only ever sees their one real placement — never the probe cycles.
// borrowedProbes: driverId → probe record (same shape as `probes` entries).
const borrowedProbes = new Map();

function configured() {
  return probes.length > 0 && probes.every((p) => p.vehicle && p.username && p.password);
}

/**
 * Declarative activation — called every monitor poll tick (like the
 * pre-armer's syncFireSessions). Cheap no-op when nothing changes.
 */
function sync({ active, dayKey, watchedVehicles, onTailSample }) {
  if (!TAIL_PROBE_ENABLED) return;

  // Day rollover resets the caps (a disabled probe gets a fresh chance
  // tomorrow; a stuck-vehicle disable still needs the manual check the
  // disable log demanded).
  if (dayKey && dayKey !== state.dayKey) {
    state.dayKey = dayKey;
    for (const p of probes) {
      p.cycles = 0;
      p.consecFailures = 0;
      p.disabledForDay = false;
    }
  }

  if (!configured()) {
    if (active && !state.collisionWarned) {
      state.collisionWarned = true;
      console.error('[TailProbe] MONITOR_TAIL_PROBE=1 but TAIL_PROBE_VEHICLE/SAN_USERNAME/SAN_PASSWORD are not all set (aligned comma lists for multiple probes) — probe stays off');
    }
    return;
  }

  // A probe vehicle that is also a REAL watched driver would fire real adds
  // and removes on a paying driver's account. Refuse loudly, once.
  const collision = probes.find((p) => watchedVehicles?.has(String(p.vehicle)));
  if (collision) {
    if (!state.collisionWarned) {
      state.collisionWarned = true;
      console.error(`[TailProbe] TAIL_PROBE_VEHICLE #${collision.vehicle} is a watched driver — probe disabled (use dedicated probe accounts)`);
    }
    state.desired = false;
    return;
  }

  state.onTailSample = onTailSample ?? state.onTailSample;
  state.desired = !!active;
  if (!state.desired) return;
  for (const p of probes) {
    if (!p.running && !p.disabledForDay && p.cycles < MAX_CYCLES_PER_DAY) {
      runLoop(p).catch((err) => console.error(`[TailProbe:${p.vehicle}] loop crashed:`, err.message));
    }
  }
}

/**
 * Declarative roster sync for BORROWED probes (real high-target drivers). The
 * monitor calls this every tick with the drivers currently safe to borrow;
 * this converges: starts loops for new borrowees, retires ones no longer in
 * the roster (or when the window closes). Separate from sync() so borrowing
 * works even with NO dedicated env accounts configured.
 *
 * roster: [{ driverId, vehicle, username, password }]  (empty = retire all)
 */
function syncRoster({ active, roster = [], dayKey, onTailSample }) {
  if (dayKey && dayKey !== state.dayKey) {
    state.dayKey = dayKey;
    borrowedProbes.clear(); // fresh day — any yesterday records are gone
  }
  state.onTailSample = onTailSample ?? state.onTailSample;
  const want = new Map((active ? roster : []).map((r) => [r.driverId, r]));

  // Retire any borrowed driver no longer wanted (window closed, or the monitor
  // handed them back for their real placement). retireBorrowed guarantees the
  // vehicle is OUT of the queue before the record is freed.
  for (const driverId of [...borrowedProbes.keys()]) {
    if (!want.has(driverId)) retireBorrowed(driverId).catch((err) =>
      console.error(`[TailProbe] retire #${driverId} failed:`, err.message));
  }

  if (!active) return;

  // Add new borrowees and (re)start idle loops.
  for (const r of want.values()) {
    if (!borrowedProbes.has(r.driverId)) {
      borrowedProbes.set(r.driverId, {
        index:          borrowedProbes.size, // stagger multiple borrowees
        driverId:       r.driverId,
        vehicle:        String(r.vehicle),
        username:       r.username,
        password:       r.password,
        borrowed:       true,
        retiring:       false,
        running:        false,
        disabledForDay: false,
        cycles:         0,
        consecFailures: 0,
        browser:        null,
        context:        null,
        page:           null,
        parked:         false,
      });
    }
    const p = borrowedProbes.get(r.driverId);
    if (!p.running && !p.retiring && !p.disabledForDay && p.cycles < MAX_CYCLES_PER_DAY) {
      // Borrowed loops ride state.desired; set it so runLoop's while-guard holds.
      state.desired = true;
      runLoop(p).catch((err) => console.error(`[TailProbe:${p.vehicle}] borrowed loop crashed:`, err.message));
    }
  }
}

/**
 * Retire a borrowed driver: stop its loop (each cycle ends with the vehicle
 * removed, so a between-cycles stop is already clean), then BELT-AND-BRACES
 * force-remove if anything is somehow left, so the monitor's real placement
 * starts from a driver guaranteed out of the queue. Idempotent.
 */
async function retireBorrowed(driverId) {
  const p = borrowedProbes.get(driverId);
  if (!p || p.retiring) return;
  p.retiring = true;

  // Let the current cycle finish (it ends server-verify removed). Bounded wait.
  const start = deps.now();
  while (p.running && deps.now() - start < 20000) await deps.sleep(200);

  // Guarantee gone before handoff. verifyDriverInQueue === null ⇒ not in queue.
  try {
    const still = await bot().verifyDriverInQueue(p.vehicle).catch(() => undefined);
    if (still !== null) {
      console.warn(`[TailProbe] borrowed #${p.vehicle} still in queue at retire — force-removing before its real placement`);
      await bot().removeFromQueue(p.username, p.password, p.vehicle).catch(() => {});
    }
  } catch { /* best-effort */ }

  await teardown(p);
  borrowedProbes.delete(driverId);
  console.log(`[TailProbe] borrowed #${p.vehicle} retired & confirmed clear — freed for its real placement`);
}

// ─── The probe loop (one per probe vehicle) ──────────────────────────────────
async function runLoop(probe) {
  probe.running = true;
  console.log(`[TailProbe] started (vehicle #${probe.vehicle}, ${MAX_CYCLES_PER_DAY - probe.cycles} cycles left today)`);
  try {
    // Interleave: offset each probe's first cycle so samples spread across
    // the cycle period instead of clumping at the same instants.
    if (probe.index > 0) await deps.sleep(probe.index * STAGGER_MS);
    while (state.desired && !probe.disabledForDay && !probe.retiring && probe.cycles < MAX_CYCLES_PER_DAY) {
      probe.cycles++;
      const ok = await runCycle(probe).catch((err) => {
        console.warn(`[TailProbe:${probe.vehicle}] cycle error: ${err.message}`);
        return false;
      });
      if (ok) {
        probe.consecFailures = 0;
      } else {
        probe.consecFailures++;
        probe.parked = false; // force a clean re-drive next cycle
        if (probe.consecFailures >= MAX_CONSEC_FAILURES) {
          await disableForDay(probe, `${probe.consecFailures} consecutive cycle failures`);
          break;
        }
        await deps.sleep(3000);
      }
      await deps.sleep(CYCLE_PAUSE_MS);
    }
    if (probe.cycles >= MAX_CYCLES_PER_DAY) {
      console.warn(`[TailProbe:${probe.vehicle}] daily cycle cap (${MAX_CYCLES_PER_DAY}) reached — stopping for today`);
    }
  } finally {
    probe.running = false;
    await teardown(probe);
  }
}

/**
 * One probe cycle: park (if needed) → add → read position → report → remove
 * → verify gone. Returns true only when EVERY step, including the server-side
 * removal check, succeeded.
 */
async function runCycle(probe) {
  const SAN_TEXT = bot()._SAN_TEXT;
  const page = await ensureParked(probe);
  if (!page) return false;

  // ADD — same in-page fast click as the armed fire path.
  const clicked = await page.evaluate((label) => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim().includes(label) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  }, SAN_TEXT.ADD_TO_QUEUE_BUTTON).catch(() => false);
  if (!clicked) { probe.parked = false; return false; }

  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    SAN_TEXT.REMOVE_FROM_QUEUE,
    { timeout: STEP_TIMEOUT_MS },
  );
  const info = await bot()._extractQueueInfo(page);
  probe.parked = false; // we're on the WAIT screen now, not the Add screen

  if (Number.isFinite(info?.position)) {
    // Report tail-count-after-our-removal (position − 1): keeps the effective
    // queue a strict lower bound of the true tail. See CONTRACT SAFETY above.
    const sample = info.position - 1;
    state.samples++;
    state.lastSamplePos = sample;
    state.lastSampleAt  = deps.now();
    console.log(`[TailProbe] tail sample: ${sample} (probe #${probe.vehicle} landed ${info.position}, cycle ${probe.cycles})`);
    try { state.onTailSample?.(sample); } catch { /* consumer errors never kill the probe */ }
  }

  // REMOVE — two-step Blazor flow (Remove From Queue → confirm screen →
  // exact-text "Remove"), then SERVER-side verification. Client transitions
  // alone are exactly what the 2026-06-30 silent-failure bug trusted; the
  // spacezone check is the truth.
  await page.click(`button:has-text("${SAN_TEXT.REMOVE_FROM_QUEUE}")`, { timeout: STEP_TIMEOUT_MS });
  const onConfirm = await page.waitForFunction(
    () => /remove vehicle from queue/i.test(document.body.innerText),
    null, { timeout: 4000 },
  ).then(() => true).catch(() => false);
  if (onConfirm) {
    await page.click('button:text-is("Remove")', { timeout: STEP_TIMEOUT_MS });
  }

  for (let check = 0; check < 4; check++) {
    await deps.sleep(1200);
    const still = await bot().verifyDriverInQueue(probe.vehicle).catch(() => undefined);
    if (still === null) {           // definitive: not in V Holding, not dispatched
      console.log(`[TailProbe] ✓ probe #${probe.vehicle} removed (cycle ${probe.cycles})`);
      return true;
    }
    if (check === 1 && still) {
      // Halfway: one re-click in case the confirm click didn't take.
      await page.click('button:text-is("Remove")', { timeout: 2000 }).catch(() => {});
    }
  }
  console.warn(`[TailProbe] ✗ probe #${probe.vehicle} still in queue after remove attempts (cycle ${probe.cycles})`);
  return false;
}

/** Launch/park a probe's page on the Add-To-Queue search result. */
async function ensureParked(probe) {
  if (probe.parked && probe.page) return probe.page;
  try {
    if (!probe.browser?.isConnected?.()) {
      if (!deps.chromium) deps.chromium = require('playwright').chromium;
      probe.browser = await deps.chromium.launch({
        headless: true,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
      probe.context = await probe.browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        viewport:  { width: 390, height: 844 },
        storageState: bot().getStoredSession(probe.username),
      });
      probe.page = await probe.context.newPage();
      await probe.page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
        return route.continue();
      });
    }
    const outcome = await bot()._driveToAddButton(probe.page, {
      sanUsername:   probe.username,
      sanPassword:   probe.password,
      vehicleNumber: probe.vehicle,
    });
    if (outcome === 'already_queued') {
      // Leftover from a failed earlier removal — clean up, then re-park.
      console.warn(`[TailProbe] probe #${probe.vehicle} already in queue at park time — removing before probing`);
      const removed = await bot().removeFromQueue(probe.username, probe.password, probe.vehicle);
      if (!removed?.success) return null;
      return ensureParked(probe);
    }
    if (outcome !== 'armed') {
      console.warn(`[TailProbe] cannot park #${probe.vehicle} (${outcome})`);
      return null;
    }
    probe.parked = true;
    return probe.page;
  } catch (err) {
    console.warn(`[TailProbe] park #${probe.vehicle} failed: ${err.message}`);
    return null;
  }
}

/** Hard stop for the day + make absolutely sure this probe isn't stranded.
 *  Scoped to ONE probe — the others keep sampling. */
async function disableForDay(probe, reason) {
  probe.disabledForDay = true;
  console.error(`[TailProbe] ⚠ probe #${probe.vehicle} DISABLED for today — ${reason}. Check the probe account/vehicle before re-enabling.`);
  try {
    const res = await bot().removeFromQueue(probe.username, probe.password, probe.vehicle);
    if (res?.success) console.log(`[TailProbe] rescue remove: probe #${probe.vehicle} confirmed out of queue`);
    else console.error(`[TailProbe] rescue remove DID NOT confirm — probe #${probe.vehicle} may still be in V Holding, remove it manually`);
  } catch (err) {
    console.error(`[TailProbe] rescue remove failed for #${probe.vehicle}: ${err.message} — remove the probe vehicle manually`);
  }
}

async function teardown(probe) {
  const b = probe.browser;
  probe.browser = null; probe.context = null; probe.page = null; probe.parked = false;
  if (b) await b.close().catch(() => {});
  console.log(`[TailProbe] stopped (#${probe.vehicle})`);
}

/** Admin/monitor visibility. */
function tailProbeStats() {
  return {
    enabled:        TAIL_PROBE_ENABLED,
    configured:     configured(),
    running:        probes.some((p) => p.running),
    disabledForDay: probes.length > 0 && probes.every((p) => p.disabledForDay),
    cycles:         probes.reduce((sum, p) => sum + p.cycles, 0),
    samples:        state.samples,
    lastSamplePos:  state.lastSamplePos,
    lastSampleAt:   state.lastSampleAt,
    probes:         probes.map((p) => ({
      vehicle:        p.vehicle,
      running:        p.running,
      disabledForDay: p.disabledForDay,
      cycles:         p.cycles,
      consecFailures: p.consecFailures,
    })),
    borrowed:       [...borrowedProbes.values()].map((p) => ({
      driverId:       p.driverId,
      vehicle:        p.vehicle,
      running:        p.running,
      retiring:       p.retiring,
      disabledForDay: p.disabledForDay,
      cycles:         p.cycles,
    })),
  };
}

/** driverIds whose borrowed probe has self-disabled (consecutive failures) —
 *  the monitor drops these from the roster so their real fire is untouched. */
function disabledBorrowedIds() {
  return [...borrowedProbes.values()].filter((p) => p.disabledForDay).map((p) => p.driverId);
}

module.exports = {
  sync,
  syncRoster,
  retireBorrowed, // targeted rescue: stop + force-remove ONE borrowed driver
  tailProbeStats,
  disabledBorrowedIds,
  // test hooks
  _state: state,
  _probes: probes,
  _borrowedProbes: borrowedProbes,
  _retireBorrowed: retireBorrowed,
  _overrideDeps: (partial) => Object.assign(deps, partial),
  _runCycle: runCycle,
  _disableForDay: disableForDay,
};
