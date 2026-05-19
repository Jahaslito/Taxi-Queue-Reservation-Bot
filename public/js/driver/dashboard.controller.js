// ─── Driver Dashboard Controller ─────────────────────────────────────────────
// Handles: today status card, recent-log list, manual requeue trigger + polling.
// Depends on: utils.js (api, esc, showToast, driverProfile)
// Also exports: formatDate, formatTime — used by history.controller.js which
//               loads after this file.

// ─── Date/time formatters ────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
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
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    document.getElementById('stat-time').textContent    = driverProfile.scheduled_time || '--:--';
    document.getElementById('stat-vehicle').textContent = driverProfile.vehicle_number;
    document.getElementById('dash-inactive-banner').style.display =
      driverProfile.is_active ? 'none' : 'block';

    // Show email verification banner if driver has an email but hasn't verified it
    const needsVerify = driverProfile.email && !driverProfile.email_verified_at;
    document.getElementById('dash-verify-banner').style.display = needsVerify ? 'block' : 'none';

    const statusData = await api('/api/driver/status/today');
    renderTodayStatus(statusData.todayLog);

    const logsData = await api('/api/driver/logs?limit=5');
    renderDashLogs(logsData.logs);
  } catch (err) {
    if (err.message.includes('token')) {
      localStorage.removeItem('driverToken');
      showView('view-login');
    }
  }
}

// ─── Today status card ────────────────────────────────────────────────────────
function renderTodayStatus(log) {
  const el = document.getElementById('today-status-content');

  if (!log) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="font-size:28px;">⏳</div>
        <div>
          <div style="font-weight:600;">Not yet queued today</div>
          <div style="font-size:13px;color:var(--muted);">Scheduled for <strong style="color:var(--white);">${driverProfile?.scheduled_time || '--:--'}</strong> PT</div>
        </div>
      </div>`;
    return;
  }

  const statusMap = {
    success:        { label: 'Success',        cls: 'badge-success' },
    already_queued: { label: 'Already Queued', cls: 'badge-success' },
    failed:         { label: 'Failed',         cls: 'badge-failed'  },
    pending:        { label: 'Running…',       cls: 'badge-pending' },
  };
  const s = statusMap[log.status] || statusMap.pending;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <span class="status-badge ${s.cls}"><span class="badge-dot"></span>${s.label}</span>
      <span style="font-size:12px;color:var(--muted);">${formatTime(log.triggered_at)}</span>
    </div>
    ${log.queue_position ? `
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
      </div>` : ''}
    ${log.error_message ? `<div style="font-size:13px;color:var(--red);margin-top:8px;">${esc(log.error_message)}</div>` : ''}`;
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
      try { renderTodayStatus(statusData.todayLog); } catch {}
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
