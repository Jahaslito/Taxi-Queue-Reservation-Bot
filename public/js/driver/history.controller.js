// ─── Driver History Controller ────────────────────────────────────────────────
// Handles: history / activity-log page.
// Depends on: utils.js (api, esc)
//             dashboard.controller.js (formatDate) — loads before this file

async function loadHistory() {
  const el = document.getElementById('history-list');
  try {
    const data = await api('/api/driver/logs?limit=30');

    if (!data.logs.length) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px 0;">No history yet</div>';
      return;
    }

    el.innerHTML = data.logs.map(log => {
      const s = {
        success:        ['✅', 'badge-success'],
        already_queued: ['✅', 'badge-success'],
        failed:         ['❌', 'badge-failed'],
        pending:        ['⏳', 'badge-pending'],
      }[log.status] || ['⏳', 'badge-pending'];

      return `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-weight:600;">${formatDate(log.triggered_at)}</span>
            <span class="status-badge ${s[1]}"><span class="badge-dot"></span>${log.status.replace('_', ' ')}</span>
          </div>
          ${log.queue_position ? `
            <div style="display:flex;gap:16px;margin-top:8px;">
              <div><span style="font-size:11px;color:var(--muted);">POS </span><strong style="color:var(--teal)">#${esc(log.queue_position)}</strong></div>
              <div><span style="font-size:11px;color:var(--muted);">LOC </span><strong>${esc(log.queue_location) || '—'}</strong></div>
              <div><span style="font-size:11px;color:var(--muted);">TIME </span><strong>${esc(log.queue_time) || '—'}</strong></div>
            </div>` : ''}
          ${log.error_message ? `<div style="font-size:12px;color:var(--red);margin-top:6px;">${esc(log.error_message)}</div>` : ''}
          <div style="font-size:11px;color:var(--muted);margin-top:8px;">
            ${log.trigger_type === 'manual' ? '🔧 Manually triggered' : '🤖 Auto-scheduled'}
          </div>
        </div>`;
    }).join('');

  } catch (err) {
    el.innerHTML = `<div style="color:var(--red);text-align:center;padding:32px;">${err.message}</div>`;
  }
}
