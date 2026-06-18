// ─── Admin Logs Controller ────────────────────────────────────────────────────
// Handles: logs list, search/date/status filters, pagination.
// Depends on: utils.js (api, esc)

// ─── Date/time formatter ─────────────────────────────────────────────────────
function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });
}

// ─── Pagination state ────────────────────────────────────────────────────────
let logsPage   = 1;
const LOGS_PER = 25;

function setLogsPagination(total) {
  const bar        = document.getElementById('logs-pagination');
  const info       = document.getElementById('logs-page-info');
  const label      = document.getElementById('logs-page-label');
  const prevBtn    = document.getElementById('logs-prev');
  const nextBtn    = document.getElementById('logs-next');
  const totalPages = Math.ceil(total / LOGS_PER) || 1;
  const from       = Math.min((logsPage - 1) * LOGS_PER + 1, total);
  const to         = Math.min(logsPage * LOGS_PER, total);

  bar.style.display = total > 0 ? 'flex' : 'none';
  info.textContent  = total > 0 ? `Showing ${from}–${to} of ${total} result${total !== 1 ? 's' : ''}` : '';
  label.textContent = `Page ${logsPage} of ${totalPages}`;
  prevBtn.disabled  = logsPage <= 1;
  nextBtn.disabled  = logsPage >= totalPages;
}

// ─── Load and render the logs list ───────────────────────────────────────────
async function loadLogs(page) {
  if (page !== undefined) logsPage = page;
  const offset    = (logsPage - 1) * LOGS_PER;
  const container = document.getElementById('logs-container');

  container.innerHTML = '<div style="color:var(--muted2);text-align:center;padding:32px;"><span class="spinner"></span></div>';
  document.getElementById('logs-pagination').style.display = 'none';

  const search = document.getElementById('log-search').value.trim();
  const date   = document.getElementById('log-date-filter').value;
  const status = document.getElementById('log-status-filter').value;

  let url = `/api/admin/logs?limit=${LOGS_PER}&offset=${offset}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  if (date)   url += `&date=${date}`;
  if (status) url += `&status=${status}`;

  try {
    const data = await api(url);
    if (!data) return; // 401 already handled by api()

    if (!data.logs.length) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No logs found for the selected filters</div>';
      setLogsPagination(0);
      return;
    }

    const iconMap = { success: '✅', already_queued: '🔁', failed: '❌', pending: '⏳' };
    const clsMap  = { success: 'success', already_queued: 'queued', failed: 'failed', pending: 'pending' };

    container.innerHTML = data.logs.map(log => {
      // Carryover markers (status 'info') are internal "still in V Holding at the
      // midnight reset" records — render them with a meaningful label, not "info".
      const isCarryover = log.trigger_type === 'carryover_marker';
      const icon       = isCarryover ? '🌙' : (iconMap[log.status] || '⏳');
      const iconCls    = isCarryover ? 'pending'  : (clsMap[log.status] || 'pending');
      const badgeCls   = isCarryover ? 'inactive' : (clsMap[log.status] || 'inactive');
      const badgeText  = isCarryover ? 'Overnight carryover' : log.status.replace('_', ' ');
      const triggerTxt = isCarryover ? '🌙 Still in V Holding at midnight reset'
                       : (log.trigger_type === 'manual' ? '🔧 Manual' : '🤖 Scheduled');

      return `
      <div class="log-entry">
        <div class="log-icon2 ${esc(iconCls)}" style="background:rgba(255,255,255,0.05);">${icon}</div>
        <div class="log-details2">
          <div class="log-title">
            <strong>${esc(log.driver_name)}</strong>
            <span style="color:var(--muted2);font-size:12px;margin-left:8px;">${esc(log.vehicle_number)}</span>
          </div>
          <div class="log-meta2">
            <span>${formatDateTime(log.triggered_at)}</span>
            ${log.queue_position ? `<span>Position: <strong>#${esc(log.queue_position)}</strong></span>` : ''}
            ${log.queue_location ? `<span>Location: <strong>${esc(log.queue_location)}</strong></span>`  : ''}
            ${log.queue_time     ? `<span>Queue Time: <strong>${esc(log.queue_time)}</strong></span>`     : ''}
            ${log.error_message  ? `<span style="color:var(--red);">${esc(log.error_message)}</span>`    : ''}
            <span><span class="badge ${esc(badgeCls)}"><span class="badge-dot"></span>${esc(badgeText)}</span></span>
            <span style="color:var(--muted);">${esc(triggerTxt)}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    setLogsPagination(data.total);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);text-align:center;padding:32px;">${err.message}</div>`;
  }
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Pagination
document.getElementById('logs-prev').addEventListener('click', () => {
  if (logsPage > 1) loadLogs(logsPage - 1);
});
document.getElementById('logs-next').addEventListener('click', () => {
  loadLogs(logsPage + 1);
});

// Debounced log search
let logSearchTimeout;
document.getElementById('log-search').addEventListener('input', () => {
  clearTimeout(logSearchTimeout);
  logSearchTimeout = setTimeout(() => loadLogs(1), 300);
});

// Apply filters button
document.getElementById('btn-filter-logs').addEventListener('click', () => loadLogs(1));
