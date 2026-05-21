// ─── Driver History Controller ────────────────────────────────────────────────
// Handles: history / activity-log page with paginated loading.
// Depends on: utils.js (api, esc)
//             dashboard.controller.js (formatDate) — loads before this file

const HISTORY_PAGE_SIZE = 10;
let historyOffset = 0;
let historyTotal  = 0;

function renderHistoryEntry(log) {
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
}

function renderHistoryPagination() {
  const ctrl = document.getElementById('history-pagination');
  if (!ctrl) return;

  const page     = Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1;
  const pages    = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const from     = historyTotal === 0 ? 0 : historyOffset + 1;
  const to       = Math.min(historyOffset + HISTORY_PAGE_SIZE, historyTotal);
  const hasPrev  = historyOffset > 0;
  const hasNext  = historyOffset + HISTORY_PAGE_SIZE < historyTotal;

  ctrl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:12px;">
      <button
        id="hist-prev"
        style="padding:8px 18px;border-radius:10px;border:1px solid var(--border);background:var(--card2);color:${hasPrev ? 'var(--teal)' : 'var(--muted)'};font-weight:600;cursor:${hasPrev ? 'pointer' : 'default'};opacity:${hasPrev ? '1' : '0.4'};"
        ${hasPrev ? '' : 'disabled'}
      >← Prev</button>
      <span style="font-size:12px;color:var(--muted);text-align:center;">
        ${historyTotal === 0 ? 'No entries' : `${from}–${to} of ${historyTotal}`}<br/>
        <span style="font-size:11px;opacity:0.6;">Page ${page} of ${pages}</span>
      </span>
      <button
        id="hist-next"
        style="padding:8px 18px;border-radius:10px;border:1px solid var(--border);background:var(--card2);color:${hasNext ? 'var(--teal)' : 'var(--muted)'};font-weight:600;cursor:${hasNext ? 'pointer' : 'default'};opacity:${hasNext ? '1' : '0.4'};"
        ${hasNext ? '' : 'disabled'}
      >Next →</button>
    </div>`;

  if (hasPrev) {
    document.getElementById('hist-prev').addEventListener('click', () => {
      historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE);
      loadHistory();
    });
  }
  if (hasNext) {
    document.getElementById('hist-next').addEventListener('click', () => {
      historyOffset += HISTORY_PAGE_SIZE;
      loadHistory();
    });
  }
}

async function loadHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px 0;">Loading…</div>';

  try {
    const data = await api(`/api/driver/logs?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`);
    historyTotal = data.total;

    if (!data.logs.length) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px 0;">No history yet</div>';
      renderHistoryPagination();
      return;
    }

    el.innerHTML = data.logs.map(renderHistoryEntry).join('');
    renderHistoryPagination();

  } catch (err) {
    el.innerHTML = `<div style="color:var(--red);text-align:center;padding:32px;">${err.message}</div>`;
  }
}
