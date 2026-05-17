// ─── Admin Overview Controller ────────────────────────────────────────────────
// Handles: stats cards, schedule-breakdown table, refresh button.
// Depends on: utils.js (api, esc, showToast)
//             logs.controller.js      (loadLogs — called by filterLogsByTime)
//             scheduledDrivers.controller.js (openSchedDriversModal — event delegation)
// Calls showPage() at runtime only — defined later in app.js, safe.

// ─── Load stats and schedule breakdown ───────────────────────────────────────
async function loadOverview() {
  const btn      = document.getElementById('btn-refresh-overview');
  const isManual = btn && !btn.disabled; // animate only on manual clicks, not boot load

  if (isManual) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner"></span> Refreshing…';
  }

  try {
    const s = await api('/api/admin/stats');
    if (!s) return; // 401 already handled

    document.getElementById('stat-total').textContent          = s.totalDrivers;
    document.getElementById('stat-active-sub').textContent     = `${s.activeDrivers} active`;
    document.getElementById('stat-today-success').textContent  = s.today.success;
    document.getElementById('stat-today-total-sub').textContent = `of ${s.today.total} total`;
    document.getElementById('stat-today-failed').textContent   = s.today.failed;
    document.getElementById('stat-alltime').textContent        = s.allTime.success;

    document.getElementById('sched-breakdown-date').textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'America/Los_Angeles',
    }) + ' PT';

    const tbody = document.getElementById('schedule-breakdown-body');
    if (!s.scheduleBreakdown.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted2);padding:20px;">No drivers scheduled today</td></tr>';
    } else {
      tbody.innerHTML = s.scheduleBreakdown.map(row => `
        <tr>
          <td><strong style="font-family:'IBM Plex Mono',monospace;font-size:16px;color:var(--teal);">${esc(row.scheduled_time)}</strong> PT</td>
          <td>${esc(row.count)} driver${row.count !== 1 ? 's' : ''}</td>
          <td style="display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" data-action="view-drivers-time" data-time="${esc(row.scheduled_time)}">View Drivers</button>
            <button class="btn btn-ghost btn-sm" data-action="view-logs-time"    data-time="${esc(row.scheduled_time)}">View Logs</button>
          </td>
        </tr>`).join('');
    }

    if (isManual) {
      btn.innerHTML   = '✓ Done';
      btn.style.color = 'var(--green)';
      setTimeout(() => {
        btn.innerHTML   = '↺ Refresh';
        btn.style.color = '';
        btn.disabled    = false;
      }, 1500);
    }
  } catch (err) {
    showToast(err.message, 'error');
    if (isManual) {
      btn.innerHTML   = '↺ Refresh';
      btn.style.color = '';
      btn.disabled    = false;
    }
  }
}

// ─── Navigate to the logs page (optionally pre-filtered by time) ──────────────
function filterLogsByTime(time) {
  showPage('page-logs');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Manual refresh button
document.getElementById('btn-refresh-overview').addEventListener('click', loadOverview);

// Event delegation for "View Drivers" / "View Logs" buttons in the breakdown table
document.getElementById('schedule-breakdown-body').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'view-logs-time')    filterLogsByTime(btn.dataset.time);
  if (btn.dataset.action === 'view-drivers-time') openSchedDriversModal(btn.dataset.time);
});
