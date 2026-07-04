// ─── Driver Dashboard Controller ─────────────────────────────────────────────
// Handles: today status card, recent-log list, manual requeue trigger + polling.
// Depends on: utils.js (api, esc, showToast, driverProfile)
// Also exports: formatDate, formatTime — used by history.controller.js which
//               loads after this file.

// ─── Date/time formatters ────────────────────────────────────────────────────
const PT = 'America/Los_Angeles';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: PT,
  });
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: PT,
  });
}

// ─── Position schedule helpers ────────────────────────────────────────────────
function getTodayPosition(profile) {
  if (profile.day_positions) {
    try {
      const dp      = JSON.parse(profile.day_positions);
      const abbr    = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
      const dayMap  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return dp[String(dayMap[abbr])] ?? null;
    } catch { return null; }
  }
  return profile.scheduled_position ?? null;
}

// ─── Requeue state ───────────────────────────────────────────────────────────
let requeueCooldown  = false;
let requeuePollTimer = null;

// ─── Dashboard data load ──────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    if (!driverProfile) {
      driverProfile = await api('/api/driver/profile');
    }
    document.getElementById('dash-name').textContent  = driverProfile.name;
    document.getElementById('dash-date').textContent  = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: PT,
    });
    if (driverProfile.day_positions || driverProfile.scheduled_position) {
      const todayPos = getTodayPosition(driverProfile);
      document.getElementById('stat-time').textContent     = todayPos ? `~${todayPos}` : 'Not set';
      document.getElementById('stat-time-lbl').textContent = 'Target Position';
    } else {
      document.getElementById('stat-time').textContent     = driverProfile.scheduled_time || 'Not set';
      document.getElementById('stat-time-lbl').textContent = 'Scheduled Time';
    }
    document.getElementById('stat-vehicle').textContent = driverProfile.vehicle_number;
    document.getElementById('dash-inactive-banner').style.display =
      driverProfile.is_active ? 'none' : 'block';

    // Show email verification banner if driver has an email but hasn't verified it
    const needsVerify = driverProfile.email && !driverProfile.email_verified_at;
    document.getElementById('dash-verify-banner').style.display = needsVerify ? 'block' : 'none';

    // Persistent "add a card" banner — stays visible until a card is on file
    // (card_required_by is cleared by the Stripe webhook once that happens).
    if (window.renderCardBanner) window.renderCardBanner(driverProfile);

    // Scheduled-cancellation grace banner — shows "access ends on <date>" while
    // a canceled-but-still-live subscription counts down to its cutoff.
    if (window.renderCancelBanner) window.renderCancelBanner(driverProfile);

    const statusData = await api('/api/driver/status/today');
    renderTodayStatus(statusData);

    const logsData = await api('/api/driver/logs?limit=5');
    renderDashLogs(logsData.logs);

    // Keep the live-position card tracking the driver's SAN state after this
    // initial load (in V Holding → dispatched → at terminal).
    startDashboardLivePolling();
  } catch (err) {
    // Driver was active when they logged in but admin has since deactivated
    // them — middleware now returns 403 + accountInactive. Show the same
    // contact-admin screen they'd see if they tried to log in fresh.
    if (err.status === 403 && err.data && err.data.accountInactive) {
      showView('view-inactive');
      return;
    }
    if (err.message.includes('token')) {
      localStorage.removeItem('driverToken');
      showView('view-login');
    }
  }
}

// ─── Live dashboard refresh ───────────────────────────────────────────────────
// The today-status card surfaces the driver's live SAN state (in V Holding /
// dispatched / at a terminal) via renderLiveLocation. That state changes as the
// monitor re-polls SAN, but loadDashboard() runs only once per view visit — so
// the card would otherwise freeze on whatever was true at load and never move
// to "Dispatched" / "At Terminal" on its own. Poll the status endpoint on an
// interval — the REST equivalent of how the admin monitor updates its cards
// live over SSE — so the driver's card tracks them through the queue.
//
// Good citizenship: pauses while the tab/PWA is backgrounded, stops itself once
// the driver navigates off the dashboard, and yields to the manual-requeue poll
// loop (which already refreshes this same card every 5s) so we never double-fetch.
const DASH_LIVE_POLL_MS = 15000;
let dashLivePollTimer = null;

function dashboardIsActive() {
  const v = document.getElementById('view-dashboard');
  return !!v && v.classList.contains('active');
}

async function refreshTodayStatusLive() {
  if (!dashboardIsActive()) { stopDashboardLivePolling(); return; } // left the view
  if (document.hidden)  return;  // backgrounded — skip tick, keep timer alive
  if (requeueCooldown)  return;  // requeue loop owns the card while the bot runs
  try {
    const statusData = await api('/api/driver/status/today');
    renderTodayStatus(statusData);
  } catch { /* transient blip — try again next tick */ }
}

function startDashboardLivePolling() {
  stopDashboardLivePolling();
  dashLivePollTimer = setInterval(refreshTodayStatusLive, DASH_LIVE_POLL_MS);
}

function stopDashboardLivePolling() {
  if (dashLivePollTimer) { clearInterval(dashLivePollTimer); dashLivePollTimer = null; }
}

// Refresh immediately when the driver brings the app back to the foreground,
// rather than making them wait up to DASH_LIVE_POLL_MS for the next tick.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && dashboardIsActive()) refreshTodayStatusLive();
});

// ─── Remove-from-queue button visibility ──────────────────────────────────────
// Show the red "Remove from Queue" button whenever the driver is observably in
// the queue RIGHT NOW. Source of truth is the monitor's live state
// (statusData.liveQueueState), not the log table — a stale log row may have a
// different status (pending requeue, monitor_requeue) even while the driver is
// still sitting in V Holding.
//
// Fallback to the log-based check only if the monitor has no opinion (driver
// not currently watched, monitor service unreachable, etc.) so we degrade
// gracefully rather than hiding the button when in doubt.
function updateRemoveQueueButtonVisibility(statusData) {
  const btn = document.getElementById('btn-remove-queue');
  if (!btn) return;
  const live = statusData && statusData.liveQueueState;
  let isInQueue;
  if (live) {
    isInQueue = live.inQueue === true;
  } else {
    const log = statusData && statusData.todayLog;
    isInQueue = log
      && (log.status === 'success' || log.status === 'already_queued')
      && Number.isFinite(log.queue_position);
  }
  btn.style.display = isInQueue ? 'flex' : 'none';
}

// ─── Today status card ────────────────────────────────────────────────────────
// `statusData` is the full /api/driver/status/today payload
// (todayLog + liveQueueState + positionTracking).
//
// Render policy: live location and target/scheduled comparison are ALWAYS
// shown when their data is available — driver shouldn't have to wait for the
// first bot fire of the day to see their target. Only log-specific bits
// (status badge, raw queue-position triplet, error message) gate on `log`.
function renderTodayStatus(statusData) {
  // Show or hide the "Remove from Queue" button based on current state
  updateRemoveQueueButtonVisibility(statusData);
  const log              = statusData && statusData.todayLog;
  const live             = statusData && statusData.liveQueueState;
  const positionTracking = statusData && statusData.positionTracking;

  const el = document.getElementById('today-status-content');

  // Always-visible strips. Each helper short-circuits to '' when its data
  // isn't available, so the only output is the parts that are actually known.
  const liveStrip       = renderLiveLocation(live);
  const comparisonStrip = renderScheduleComparison(driverProfile, log, positionTracking);

  // Header: log-status badge if we have a log today, otherwise the
  // "scheduled by …" preamble.
  let headerHtml;
  if (log) {
    const statusMap = {
      success:        { label: 'Success',        cls: 'badge-success' },
      already_queued: { label: 'Already Queued', cls: 'badge-success' },
      failed:         { label: 'Failed',         cls: 'badge-failed'  },
      pending:        { label: 'Running…',       cls: 'badge-pending' },
    };
    const s = statusMap[log.status] || statusMap.pending;
    headerHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span class="status-badge ${s.cls}"><span class="badge-dot"></span>${s.label}</span>
        <span style="font-size:12px;color:var(--muted);">${formatTime(log.triggered_at)}</span>
      </div>`;
  } else {
    const todayPos  = driverProfile ? getTodayPosition(driverProfile) : null;
    const schedInfo = todayPos
      ? `📍 position <strong style="color:var(--white);">~${todayPos}</strong>`
      : (driverProfile?.day_positions || driverProfile?.scheduled_position)
        ? '📍 position-based schedule (no target for today)'
        : `<strong style="color:var(--white);">${driverProfile?.scheduled_time || '--:--'}</strong> PT`;
    headerHtml = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="font-size:28px;">⏳</div>
        <div>
          <div style="font-weight:600;">Not yet queued today</div>
          <div style="font-size:13px;color:var(--muted);">Scheduled by ${schedInfo}</div>
        </div>
      </div>`;
  }

  // Footer: log detail rows + error. Only rendered when log exists.
  // The raw position/location/queueTime triplet is suppressed when liveStrip
  // is already showing position info — avoids duplicating the same number.
  let footerHtml = '';
  if (log && log.queue_position && !live) {
    footerHtml += `
      <div style="display:flex;gap:20px;">
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">Position</div>
          <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:700;color:var(--teal);">${esc(log.queue_position)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">Location</div>
          <div style="font-size:16px;font-weight:600;margin-top:4px;">${esc(log.queue_location) || 'N/A'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">Queue Time</div>
          <div style="font-size:16px;font-weight:600;margin-top:4px;">${esc(log.queue_time) || 'N/A'}</div>
        </div>
      </div>`;
  }
  if (log && log.error_message) {
    footerHtml += `<div style="font-size:13px;color:var(--red);margin-top:8px;">${esc(log.error_message)}</div>`;
  }

  el.innerHTML = headerHtml + liveStrip + comparisonStrip + footerHtml;
}

// ─── Live location strip ──────────────────────────────────────────────────────
// Reads the monitor's current view of the driver: in V Holding, dispatched out
// of V Holding (waiting to be assigned a gate), or physically at T1/T2. The
// monitor updates currentPosition / terminalName on every poll, so this strip
// reflects what the driver would see if they refreshed the SAN page right now.
function renderLiveLocation(live) {
  if (!live) return '';

  const tile = (label, value, color) => `
    <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:12px;padding:14px;">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">${label}</div>
      <div style="font-family:'Syne',sans-serif;font-size:24px;font-weight:700;color:${color};margin-top:4px;">${value}</div>
    </div>`;

  let label, value, color;
  switch (live.state) {
    case 'in_queue':
      label = 'In V Holding';
      value = Number.isFinite(live.currentPosition) ? `#${live.currentPosition}` : '—';
      color = 'var(--teal)';
      break;
    case 'dispatched':
      label = 'Dispatched';
      value = Number.isFinite(live.currentPosition) ? `#${live.currentPosition}` : '—';
      color = 'var(--amber, #f5a623)';
      break;
    case 'at_terminal':
      label = live.terminalName === 'T1' ? 'At Terminal 1'
            : live.terminalName === 'T2' ? 'At Terminal 2'
            : 'At Terminal';
      value = Number.isFinite(live.terminalPosition) ? `#${live.terminalPosition}` : 'waiting…';
      color = 'var(--green, #22c55e)';
      break;
    case 'requeuing':
      label = 'Bot Running';
      value = '⏳';
      color = 'var(--teal)';
      break;
    case 'watching':
      // Monitor knows about this driver but hasn't observed them in V Holding
      // since this session started. Show the reassurance that we're watching
      // rather than hiding the strip — drivers want to see the system is on.
      label = 'Monitoring';
      value = 'Not in queue';
      color = 'var(--muted)';
      break;
    default:
      return ''; // unknown state — nothing useful to show
  }
  return `<div style="display:flex;gap:10px;margin-bottom:12px;">${tile(label, value, color)}</div>`;
}

// ─── Scheduled vs Queued comparison ───────────────────────────────────────────
// Time-scheduled drivers see Scheduled time vs the time the bot actually
// queued them. Position-scheduled drivers used to see Target vs Actual
// position here, but the +/- delta was confusing drivers, so that card was
// removed — position-scheduled drivers now only see live status and live
// queue position from the rest of the dashboard.
//
// `log` may be null when called before the first bot fire of the day —
// scheduled is still rendered (sourced from the driver profile), and
// queued shows "pending…" until the log row appears.
function renderScheduleComparison(profile, log, _posTracking) {
  if (!profile) return '';

  // Position-scheduled drivers: no comparison card — Target/Actual was
  // intentionally removed because the +/- delta confused drivers.
  if (profile.day_positions || profile.scheduled_position) return '';

  // Time-scheduled: show 'Not set today' when there's no scheduled time for
  // today rather than hiding the row.
  const scheduled = getTodayScheduledTime(profile);
  const queuedAt  = log ? (log.queue_time || formatTime(log.triggered_at)) : null;
  return comparisonRow(
    { label: 'Scheduled', value: scheduled || 'Not set today' },
    { label: 'Queued',    value: queuedAt  || 'pending…'      },
  );
}

function getTodayScheduledTime(profile) {
  if (profile.day_schedules) {
    try {
      const ds   = JSON.parse(profile.day_schedules);
      const abbr = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: PT });
      const map  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return ds[String(map[abbr])] || null;
    } catch { /* fall through */ }
  }
  return profile.scheduled_time || null;
}

function comparisonRow(left, right) {
  const deltaTag = Number.isFinite(right.delta)
    ? `<span style="font-size:12px;font-weight:700;color:${right.delta > 0 ? '#f87171' : (right.delta < 0 ? '#86efac' : 'var(--muted)')};margin-left:6px;">
         ${right.delta > 0 ? '+' : ''}${right.delta}${right.deltaSuffix ? ` ${right.deltaSuffix}` : ''}
       </span>`
    : '';
  const cell = (label, value) => `
    <div style="flex:1;">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">${esc(label)}</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px;">${esc(value)}</div>
    </div>`;
  return `
    <div style="display:flex;align-items:center;gap:16px;background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px;">
      ${cell(left.label, left.value)}
      <div style="font-size:18px;color:var(--muted);">→</div>
      ${cell(right.label, right.value)}
      ${deltaTag}
    </div>`;
}

// ─── Requeue button visual state ──────────────────────────────────────────────
function setRequeueBusy(busy) {
  const btn     = document.getElementById('btn-requeue');
  const icon    = document.getElementById('btn-requeue-icon');
  const label   = document.getElementById('btn-requeue-label');
  const sub     = document.getElementById('btn-requeue-sub');
  const chevron = document.getElementById('btn-requeue-chevron');
  const spinner = document.getElementById('btn-requeue-spinner');

  if (busy) {
    icon.textContent        = '⏳';
    label.textContent       = 'Running…';
    sub.textContent         = 'The bot is connecting to eDispatch — hold tight';
    chevron.style.display   = 'none';
    spinner.style.display   = 'block';
    btn.style.opacity       = '0.65';
    btn.style.cursor        = 'not-allowed';
    btn.style.pointerEvents = 'none';
    btn.style.boxShadow     = '0 2px 8px rgba(0,180,255,0.1)';
    btn.style.transform     = 'translateY(1px)';
  } else {
    icon.textContent        = '⚡';
    label.textContent       = 'Get Back in Queue';
    sub.textContent         = 'Run the bot now — no need to wait for your schedule';
    chevron.style.display   = '';
    spinner.style.display   = 'none';
    btn.style.opacity       = '1';
    btn.style.cursor        = 'pointer';
    btn.style.pointerEvents = '';
    btn.style.boxShadow     = '0 4px 20px rgba(0,180,255,0.2), 0 2px 0 rgba(0,180,255,0.35), 0 1px 0 rgba(255,255,255,0.06) inset';
    btn.style.transform     = '';
  }
}

// ─── Trigger / requeue ────────────────────────────────────────────────────────
async function triggerRequeue() {
  if (requeueCooldown) return;
  requeueCooldown = true;
  setRequeueBusy(true);

  // `settled` at function scope so the safety-valve setTimeout can see it.
  // (let inside a try-block is invisible to finally — JS scoping pitfall)
  let settled = false;

  // Snapshot current log state before triggering so we can detect completion.
  let preLogId           = null;
  let startedWithPending = false;
  try {
    const pre = await api('/api/driver/status/today');
    if (pre.todayLog) {
      preLogId           = pre.todayLog.id;
      startedWithPending = pre.todayLog.status === 'pending';
    }
  } catch { /* best-effort — nulls are safe */ }

  try {
    await api('/api/driver/trigger', { method: 'POST' });
    showToast('⚡ Bot is running — results will appear in your history shortly');

    let polls      = 0;
    let sawPending = startedWithPending; // treat a pre-existing pending log as "ours" too
    clearInterval(requeuePollTimer);

    requeuePollTimer = setInterval(async () => {
      polls++;

      // ── Fetch ─────────────────────────────────────────────────────────────
      let statusData, logsData;
      try {
        [statusData, logsData] = await Promise.all([
          api('/api/driver/status/today'),
          api('/api/driver/logs?limit=5'),
        ]);
      } catch {
        // Network blip — skip this tick, keep the interval alive
        return;
      }

      // ── Update UI (isolated so a render error never swallows the toast) ───
      try { renderTodayStatus(statusData); } catch {}
      try { renderDashLogs(logsData.logs);           } catch {}

      // ── Decide if we're done ──────────────────────────────────────────────
      const log = statusData.todayLog;

      if (log && log.status === 'pending') sawPending = true;
      const isNewLog = log && String(log.id) !== String(preLogId);
      const done     = (sawPending || isNewLog) && log && log.status !== 'pending';
      const timedOut = polls >= 18;

      if (done || timedOut) {
        clearInterval(requeuePollTimer);
        settled = true;

        if (done) {
          const s   = log.status;
          const pos = log.queue_position ? ` at position #${log.queue_position}` : '';
          if (s === 'success' || s === 'already_queued') {
            showToast(`✅ You're back in the queue${pos}!`, 'success', 5000);
          } else if (s === 'failed') {
            showToast('❌ Bot ran but failed to queue — check your History for details', 'error', 5000);
          } else {
            showToast(`Bot finished (${s})`, 'success', 5000);
          }
        } else {
          showToast('⏱ Still waiting on a result — check your History tab shortly', 'error', 5000);
        }

        // Restore the button 2 s after the toast so users read it first
        setTimeout(() => {
          requeueCooldown = false;
          setRequeueBusy(false);
        }, 2000);
      }
    }, 5000);

  } catch (err) {
    showToast('Failed to trigger bot: ' + err.message, 'error');
    settled        = true;
    requeueCooldown = false;
    setRequeueBusy(false);
  }

  // Safety valve — restores button after 2 min if something goes silently wrong
  setTimeout(() => {
    if (!settled) {
      requeueCooldown = false;
      setRequeueBusy(false);
    }
  }, 120000);
}

// ─── Recent activity list on dashboard ───────────────────────────────────────
function renderDashLogs(logs) {
  const el = document.getElementById('dash-logs');
  if (!logs || logs.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:14px;text-align:center;padding:16px;">No activity yet</div>';
    return;
  }
  el.innerHTML = logs.map(log => {
    const iconMap = { success: '✅', already_queued: '✅', failed: '❌', pending: '⏳' };
    const clsMap  = { success: 'success', already_queued: 'success', failed: 'failed', pending: 'pending' };
    return `
      <div class="log-item">
        <div class="log-icon ${clsMap[log.status]}">${iconMap[log.status] || '⏳'}</div>
        <div class="log-details">
          <div class="log-date">${formatDate(log.triggered_at)}</div>
          <div class="log-meta">${esc(log.queue_location || log.error_message || log.status)}</div>
        </div>
        ${log.queue_position ? `<div class="log-pos">#${log.queue_position}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Trigger button
document.getElementById('btn-requeue').addEventListener('click', triggerRequeue);

// ─── Remove-from-queue flow ──────────────────────────────────────────────────
// Confirmation modal → API call (8-15s) → toast + state update.
// While the bot runs, the modal's confirm button shows a spinner and is disabled.
let removeQueueInFlight = false;

function openRemoveQueueModal() {
  if (removeQueueInFlight) return;
  document.getElementById('remove-queue-modal').classList.add('open');
}

function closeRemoveQueueModal() {
  if (removeQueueInFlight) return; // can't dismiss while bot is running
  document.getElementById('remove-queue-modal').classList.remove('open');
}

async function performRemoveFromQueue() {
  if (removeQueueInFlight) return;
  removeQueueInFlight = true;

  const confirmBtn   = document.getElementById('btn-remove-queue-confirm');
  const cancelBtn    = document.getElementById('btn-remove-queue-cancel');
  const confirmLabel = document.getElementById('btn-remove-queue-confirm-label');
  const confirmSpin  = document.getElementById('btn-remove-queue-confirm-spinner');

  // Also disable the main "Remove from Queue" button on the dashboard
  const dashBtn      = document.getElementById('btn-remove-queue');
  const dashBtnLabel = document.getElementById('btn-remove-queue-label');
  const dashBtnSub   = document.getElementById('btn-remove-queue-sub');
  const dashBtnSpin  = document.getElementById('btn-remove-queue-spinner');
  const dashBtnIcon  = document.getElementById('btn-remove-queue-icon');

  // Loading state on the modal's confirm button
  confirmBtn.disabled         = true;
  cancelBtn.disabled          = true;
  cancelBtn.style.opacity     = '0.5';
  cancelBtn.style.cursor      = 'not-allowed';
  confirmLabel.textContent    = 'Removing…';
  confirmSpin.style.display   = 'inline-block';

  // Mirror loading state on the dashboard button (in case modal closes early)
  dashBtn.style.opacity       = '0.65';
  dashBtn.style.cursor        = 'not-allowed';
  dashBtn.style.pointerEvents = 'none';
  dashBtnIcon.textContent     = '⏳';
  dashBtnLabel.textContent    = 'Removing from queue…';
  dashBtnSub.textContent      = 'Connecting to SAN eDispatch';
  dashBtnSpin.style.display   = 'block';

  try {
    const data = await api('/api/driver/remove-queue', { method: 'POST' });

    // Successful removal
    if (data && data.ok) {
      showToast('✅ ' + (data.message || 'Removed from queue.'), 'success', 5000);
      // Hide the button immediately — driver is no longer in queue
      dashBtn.style.display = 'none';
      // Refresh status so the dashboard updates
      const statusData = await api('/api/driver/status/today');
      renderTodayStatus(statusData);
    } else if (data && data.reason === 'not_in_queue') {
      // Soft failure — driver wasn't in queue to begin with
      showToast('ℹ ' + (data.message || 'You are not in the queue.'), 'success', 4000);
      dashBtn.style.display = 'none';
    } else {
      // Shouldn't reach here for 200 responses, but just in case
      showToast('Could not remove: ' + (data && data.message ? data.message : 'unknown error'), 'error', 5000);
    }
  } catch (err) {
    // 409 dispatched, 502 bot failure, network errors, etc.
    const msg = err.message || 'Failed to remove from queue';
    showToast('❌ ' + msg, 'error', 6000);
  } finally {
    // Reset modal + dashboard button state
    removeQueueInFlight         = false;
    confirmBtn.disabled         = false;
    cancelBtn.disabled          = false;
    cancelBtn.style.opacity     = '';
    cancelBtn.style.cursor      = '';
    confirmLabel.textContent    = 'Yes, remove me';
    confirmSpin.style.display   = 'none';

    dashBtn.style.opacity       = '';
    dashBtn.style.cursor        = '';
    dashBtn.style.pointerEvents = '';
    dashBtnIcon.textContent     = '✕';
    dashBtnLabel.textContent    = 'Remove from Queue';
    dashBtnSub.textContent      = 'Done driving for today — opt out of auto-requeue';
    dashBtnSpin.style.display   = 'none';

    // Close modal
    document.getElementById('remove-queue-modal').classList.remove('open');
  }
}

document.getElementById('btn-remove-queue').addEventListener('click', openRemoveQueueModal);
document.getElementById('btn-remove-queue-cancel').addEventListener('click', closeRemoveQueueModal);
document.getElementById('btn-remove-queue-confirm').addEventListener('click', performRemoveFromQueue);

// Dismiss modal by tapping outside the dialog (but not during loading)
document.getElementById('remove-queue-modal').addEventListener('click', (e) => {
  if (e.target.id === 'remove-queue-modal' && !removeQueueInFlight) {
    closeRemoveQueueModal();
  }
});

// Press effect: sink the button on mousedown/touchstart, lift on release
(function () {
  const btn = document.getElementById('btn-requeue');
  function press()   { if (!requeueCooldown) { btn.style.transform = 'translateY(2px)'; btn.style.boxShadow = '0 1px 6px rgba(0,180,255,0.15)'; } }
  function release() { if (!requeueCooldown) { btn.style.transform = '';                btn.style.boxShadow = ''; } }
  btn.addEventListener('mousedown',  press);
  btn.addEventListener('touchstart', press,   { passive: true });
  btn.addEventListener('mouseup',    release);
  btn.addEventListener('touchend',   release);
  btn.addEventListener('mouseleave', release);
}());
