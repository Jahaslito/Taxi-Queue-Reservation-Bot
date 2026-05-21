// ─── Watchlist Controller ─────────────────────────────────────────────────────
// Auto-monitors all active drivers. Backed by a single SSE stream + REST API.
// Scalability strategy:
//   • Full driver list loaded once via REST on page show (paginated).
//   • SSE stream sends only state-change events → frontend patches the local
//     cache Map and re-renders only the affected row (if on current page).
//   • No full re-renders: only the row that changed is updated in the DOM.
// Depends on: utils.js (api, esc, showToast)

// ─── State ───────────────────────────────────────────────────────────────────
let wlSSE        = null;
let wlCache      = new Map();   // driverId → snap
let wlPage       = 1;
let wlLimit      = 50;
let wlTotalPages = 1;
let wlTotal      = 0;
let wlLoading    = false;
let wlLastPoll   = null;
let wlPollTimer  = null;
let wlRunning    = new Set();   // driverIds with in-flight manual run

let wlSearch     = '';
let wlStatus     = 'all';
let wlSortBy     = 'vehicleNumber';
let wlSortDir    = 'asc';

// ─── Time helpers (same as monitor.controller.js) ────────────────────────────
function wlRelTime(iso) {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

function wlFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles' });
}

// ─── State badge (compact) ───────────────────────────────────────────────────
function wlBadge(state) {
  const map = {
    watching:        ['var(--muted2)',  '👁',  'Watching'],
    in_queue:        ['var(--green)',   '✅', 'In Queue'],
    dispatched:      ['var(--amber)',   '🚖', 'Dispatched'],
    at_terminal:     ['var(--purple)',  '✈',  'At Terminal'],
    gone:            ['var(--red)',     '🔴', 'Gone'],
    requeuing:       ['var(--blue)',    '⚡', 'Re-queuing'],
    not_authorized:  ['var(--red)',     '🚫', 'Not Authorized'],
  };
  const [color, icon, label] = map[state] || ['var(--muted)', '?', state];
  return `<span style="
    display:inline-flex;align-items:center;gap:4px;
    padding:3px 9px;border-radius:16px;font-size:11px;font-weight:700;
    background:${color}1a;color:${color};border:1px solid ${color}40;white-space:nowrap;">
    ${icon} ${label}
  </span>`;
}

// ─── Result badge ────────────────────────────────────────────────────────────
function wlResultBadge(result) {
  if (!result) return '<span style="color:var(--muted);">—</span>';
  return result.success
    ? '<span style="color:var(--green);font-size:16px;" title="Success">✅</span>'
    : `<span style="color:var(--red);font-size:16px;" title="${esc(result.error || 'Failed')}">❌</span>`;
}

// ─── Render a single table row ────────────────────────────────────────────────
function wlRenderRow(s) {
  const isRunning  = wlRunning.has(s.driverId) || s.state === 'requeuing';
  const runLabel   = isRunning ? '⏳' : '▶ Run';
  const runDisabled = isRunning ? 'disabled' : '';

  return `<tr data-driver-id="${s.driverId}">
    <td style="font-family:'IBM Plex Mono',monospace;font-weight:700;color:var(--teal);">#${esc(s.vehicleNumber)}</td>
    <td style="color:var(--white);">${esc(s.driverName || '—')}</td>
    <td>${wlBadge(s.state)}</td>
    <td style="font-size:12px;color:var(--muted2);">${wlFmtTime(s.lastSeenAt)}</td>
    <td style="font-size:12px;color:var(--muted2);">${wlFmtTime(s.lastDispatchAt)}</td>
    <td style="font-size:12px;color:var(--muted2);">${wlFmtTime(s.lastRequeuedAt)}</td>
    <td style="text-align:center;font-family:'IBM Plex Mono',monospace;">
      ${s.requeueCountToday > 0
        ? `<strong style="color:var(--blue);">${s.requeueCountToday}</strong>`
        : '<span style="color:var(--muted);">0</span>'}
    </td>
    <td style="text-align:center;font-family:'IBM Plex Mono',monospace;">
      ${s.state === 'at_terminal' && s.terminalPosition != null
        ? `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;">
             <strong style="color:var(--purple);" title="${s.terminalName || 'Terminal'} position #${s.terminalPosition}">#${s.terminalPosition}</strong>
             <span style="font-size:10px;color:var(--purple);opacity:0.8;">${esc(s.terminalName || 'T?')}</span>
           </div>`
        : s.currentPosition
          ? `<strong style="color:var(--teal);" title="Last re-queued at #${s.lastPosition || '?'}">#${s.currentPosition}</strong>`
          : '<span style="color:var(--muted);">—</span>'}
    </td>
    <td style="text-align:center;">${wlResultBadge(s.lastResult)}</td>
    <td style="text-align:center;">
      <button class="btn btn-ghost btn-sm wl-run-btn"
        data-driver-id="${s.driverId}"
        data-vehicle="${esc(s.vehicleNumber)}"
        ${runDisabled}
        style="min-width:60px;${isRunning ? 'opacity:0.5;cursor:not-allowed;' : ''}">
        ${runLabel}
      </button>
    </td>
  </tr>`;
}

// ─── Patch a single row in the table (no full re-render) ─────────────────────
function wlPatchRow(driverId) {
  const s   = wlCache.get(driverId);
  if (!s) return;
  const row = document.querySelector(`#wl-tbody tr[data-driver-id="${driverId}"]`);
  if (!row) return; // driver not on current page — cache updated, no DOM work needed
  const el = document.createElement('tbody');
  el.innerHTML = wlRenderRow(s);
  row.replaceWith(el.firstElementChild);
}

// ─── Render the full table (only visible page) ────────────────────────────────
function wlRenderTable() {
  const tbody = document.getElementById('wl-tbody');
  if (!tbody) return;

  if (wlLoading) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted2);padding:32px;">Loading…</td></tr>';
    return;
  }

  // Build sorted/filtered view from cache
  let items = [...wlCache.values()];

  if (wlSearch) {
    const q = wlSearch.toLowerCase();
    items = items.filter(
      (s) => s.vehicleNumber.toLowerCase().includes(q) ||
             (s.driverName && s.driverName.toLowerCase().includes(q)),
    );
  }

  if (wlStatus !== 'all') {
    items = items.filter((s) => s.state === wlStatus);
  }

  // Sort
  items.sort((a, b) => {
    let va, vb;
    switch (wlSortBy) {
      case 'driverName':     va = a.driverName || ''; vb = b.driverName || '';    break;
      case 'state':          va = a.state;            vb = b.state;               break;
      case 'requeuedToday':  va = a.requeueCountToday; vb = b.requeueCountToday;  break;
      case 'lastRequeuedAt': va = a.lastRequeuedAt ? new Date(a.lastRequeuedAt).getTime() : 0;
                             vb = b.lastRequeuedAt ? new Date(b.lastRequeuedAt).getTime() : 0;
                             break;
      default:               va = a.vehicleNumber;   vb = b.vehicleNumber;
    }
    if (typeof va === 'string') return wlSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    return wlSortDir === 'desc' ? vb - va : va - vb;
  });

  wlTotal      = items.length;
  wlTotalPages = Math.ceil(wlTotal / wlLimit) || 1;
  if (wlPage > wlTotalPages) wlPage = wlTotalPages;

  const offset    = (wlPage - 1) * wlLimit;
  const pageItems = items.slice(offset, offset + wlLimit);

  if (!pageItems.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted2);padding:32px;">No drivers match the current filter</td></tr>';
  } else {
    tbody.innerHTML = pageItems.map(wlRenderRow).join('');
  }

  wlUpdatePagination();
}

// ─── Pagination controls ──────────────────────────────────────────────────────
function wlUpdatePagination() {
  const wrap  = document.getElementById('wl-pagination');
  const info  = document.getElementById('wl-page-info');
  const label = document.getElementById('wl-page-label');
  const prev  = document.getElementById('wl-prev');
  const next  = document.getElementById('wl-next');

  if (wlTotal <= wlLimit) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display   = 'flex';
  const from = (wlPage - 1) * wlLimit + 1;
  const to   = Math.min(wlPage * wlLimit, wlTotal);
  info.textContent     = `Showing ${from}–${to} of ${wlTotal} drivers`;
  label.textContent    = `Page ${wlPage} of ${wlTotalPages}`;
  prev.disabled        = wlPage <= 1;
  next.disabled        = wlPage >= wlTotalPages;
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function wlUpdateStats(stats) {
  if (!stats) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
  set('wls-total',      stats.total      ?? '—');
  set('wls-inqueue',    stats.inQueue    ?? '—');
  set('wls-dispatched', stats.dispatched ?? '—');
  set('wls-gone',       (stats.gone ?? 0) + (stats.requeuing ?? 0));
  set('wls-today',      stats.requeuedToday ?? '—');
  set('wls-watching',   stats.watching   ?? '—');
  if (stats.jobQueue) {
    set('wl-bot-active',  stats.jobQueue.active);
    set('wl-bot-pending', stats.jobQueue.pending);
  }
}

function wlUpdatePollBar(pollStats) {
  if (!pollStats) return;
  if (pollStats.pollAt) {
    wlLastPoll = new Date(pollStats.pollAt);
    document.getElementById('wl-last-poll').textContent = wlRelTime(pollStats.pollAt);
  }
  if (pollStats.fetchMs != null) {
    document.getElementById('wl-fetch-ms').textContent = `${pollStats.fetchMs}ms`;
  }
  if (pollStats.operatingHours) wlUpdateHoursBanner(pollStats.operatingHours);
}

function wlUpdateHoursBanner(oh) {
  let banner = document.getElementById('wl-hours-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'wl-hours-banner';
    banner.style.cssText = `
      display:flex;align-items:center;gap:10px;padding:10px 18px;
      border-radius:10px;margin-bottom:16px;font-size:13px;font-weight:600;
    `;
    const wrap = document.getElementById('wl-status-bar');
    wrap.insertAdjacentElement('afterend', banner);
  }
  if (oh.active) {
    banner.style.display = 'none';
  } else {
    banner.style.display   = 'flex';
    banner.style.background = 'rgba(245,166,35,0.1)';
    banner.style.border     = '1px solid rgba(245,166,35,0.3)';
    banner.style.color      = 'var(--amber)';
    banner.innerHTML = `⏸ Auto-requeue paused — outside operating hours (${oh.startHour}:00–${oh.endHour}:00 PT). Resumes at ${oh.startHour}:00 AM PT. Manual ▶ Run still works.`;
  }
}

function wlTickPollBar() {
  if (wlLastPoll) {
    document.getElementById('wl-last-poll').textContent = wlRelTime(wlLastPoll);
  }
}

// ─── Derive stats from the cache (avoids a round-trip after every SSE event) ─
function wlStatsFromCache() {
  const all = [...wlCache.values()];
  return {
    total:         all.length,
    watching:      all.filter((s) => s.state === 'watching').length,
    inQueue:       all.filter((s) => s.state === 'in_queue').length,
    dispatched:    all.filter((s) => s.state === 'dispatched').length,
    gone:          all.filter((s) => s.state === 'gone').length,
    requeuing:     all.filter((s) => s.state === 'requeuing').length,
    requeuedToday: all.reduce((n, s) => n + (s.requeueCountToday || 0), 0),
  };
}

// ─── Load initial table via REST (paginated, auth-gated) ─────────────────────
async function wlLoadAll() {
  wlLoading = true;
  wlRenderTable();

  // Load ALL driver states into the local cache in one call (no pagination needed
  // since data is in-memory on server — up to 200 per page, fetch all pages).
  wlCache.clear();
  let page = 1;
  let fetched = 0;
  let total = Infinity;

  while (fetched < total) {
    const data = await api(`/api/admin/watchlist?page=${page}&limit=200&sortBy=vehicleNumber`);
    if (!data) break; // 401 — auth redirect handled by api()
    for (const s of data.items) wlCache.set(s.driverId, s);
    fetched += data.items.length;
    total    = data.total;
    if (data.items.length < 200) break;
    page++;
  }

  wlLoading = false;
  wlRenderTable();
  wlUpdateStats(wlStatsFromCache());
}

// ─── SSE connection ───────────────────────────────────────────────────────────
function wlConnectSSE() {
  if (wlSSE) { wlSSE.close(); wlSSE = null; }

  const dot   = document.getElementById('wl-dot');
  const label = document.getElementById('wl-live-label');
  const navDot = document.getElementById('watchlist-live-dot');

  function setConnected(ok) {
    dot.style.background  = ok ? 'var(--green)' : 'var(--red)';
    dot.style.boxShadow   = ok ? '0 0 6px var(--green)' : 'none';
    label.textContent     = ok ? 'Live' : 'Reconnecting…';
    label.style.color     = ok ? 'var(--green)' : 'var(--red)';
    if (navDot) navDot.style.display = ok ? 'inline-block' : 'none';
  }

  wlSSE = new EventSource('/api/admin/watchlist/stream', { withCredentials: true });

  wlSSE.onopen = () => {
    setConnected(true);
    // On reconnect (cache already populated from a previous load), refresh all
    // driver states from REST so any changes that occurred while the SSE was
    // disconnected (e.g. server restart) are reflected immediately rather than
    // waiting for the next individual driver_state event.
    if (wlCache.size > 0) wlLoadAll();
  };

  wlSSE.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {

      case 'wl_init': {
        // Lightweight init — stats + poll status only (no full dump)
        wlUpdateStats(msg.payload.stats);
        wlUpdatePollBar(msg.payload.pollStats);
        if (msg.payload.stats?.operatingHours) wlUpdateHoursBanner(msg.payload.stats.operatingHours);
        if (msg.payload.jobQueue) {
          document.getElementById('wl-bot-active').textContent  = msg.payload.jobQueue.active;
          document.getElementById('wl-bot-pending').textContent = msg.payload.jobQueue.pending;
        }
        break;
      }

      case 'poll': {
        wlUpdatePollBar(msg.payload);
        break;
      }

      case 'poll_error': {
        document.getElementById('wl-last-poll').textContent = '⚠ Poll error';
        break;
      }

      case 'driver_state': {
        const { driverId, state } = msg.payload;
        // Update cache
        wlCache.set(driverId, state);
        // Patch row if visible; otherwise just update stats
        wlPatchRow(driverId);
        wlUpdateStats(wlStatsFromCache());
        break;
      }

      case 'watch_added': {
        const { driverId, state } = msg.payload;
        wlCache.set(driverId, state);
        // If on first page and sorted by vehicle, new driver may need a full re-render
        wlRenderTable();
        wlUpdateStats(wlStatsFromCache());
        break;
      }

      case 'watch_removed': {
        wlCache.delete(msg.payload.driverId);
        wlRenderTable();
        wlUpdateStats(wlStatsFromCache());
        break;
      }

      case 'requeue_triggered': {
        const { driverId, vehicleNumber } = msg.payload;
        wlRunning.add(driverId);
        showToast(`⚡ Re-queuing #${vehicleNumber}…`, 'success', 3000);
        wlPatchRow(driverId);
        break;
      }

      case 'requeue_result': {
        const { driverId, vehicleNumber, result } = msg.payload;
        wlRunning.delete(driverId);
        const ok = result?.success;
        showToast(
          ok
            ? `✅ #${vehicleNumber} re-queued at position #${result.position || '?'}`
            : `❌ Re-queue failed for #${vehicleNumber}`,
          ok ? 'success' : 'error',
          5000,
        );
        wlPatchRow(driverId);
        wlUpdateStats(wlStatsFromCache());
        break;
      }

      case 'daily_reset': {
        // Daily counters reset — update stats display
        for (const s of wlCache.values()) s.requeueCountToday = 0;
        wlUpdateStats(wlStatsFromCache());
        wlRenderTable();
        showToast('📅 Daily re-queue counters reset', 'success', 4000);
        break;
      }
    }
  };

  wlSSE.onerror = () => {
    setConnected(false);
    setTimeout(() => {
      if (document.getElementById('page-watchlist')?.classList.contains('active')) {
        wlConnectSSE();
      }
    }, 5000);
  };
}

function wlDisconnectSSE() {
  if (wlSSE) { wlSSE.close(); wlSSE = null; }
  if (wlPollTimer) { clearInterval(wlPollTimer); wlPollTimer = null; }
  const navDot = document.getElementById('watchlist-live-dot');
  if (navDot) navDot.style.display = 'none';
}

// ─── Manual "Run" button handler ──────────────────────────────────────────────
async function wlHandleRun(driverId, vehicleNumber) {
  if (wlRunning.has(driverId)) return;
  wlRunning.add(driverId);
  wlPatchRow(driverId); // immediately show ⏳

  try {
    await api(`/api/admin/watchlist/run/${driverId}`, { method: 'POST' });
    showToast(`⚡ Bot triggered for #${vehicleNumber}`, 'success', 3000);
  } catch (err) {
    wlRunning.delete(driverId);
    wlPatchRow(driverId); // restore Run button
    showToast(err.message || 'Failed to trigger bot', 'error');
  }
}

// ─── Event delegation for Run buttons (handles rows added by wlRenderTable) ───
document.getElementById('wl-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.wl-run-btn');
  if (!btn || btn.disabled) return;
  const driverId     = parseInt(btn.dataset.driverId, 10);
  const vehicleNumber = btn.dataset.vehicle;
  wlHandleRun(driverId, vehicleNumber);
});

// ─── Filter/sort controls ─────────────────────────────────────────────────────
document.getElementById('wl-search').addEventListener('input', (e) => {
  wlSearch = e.target.value.trim();
  wlPage   = 1;
  wlRenderTable();
});

document.getElementById('wl-status-filter').addEventListener('change', (e) => {
  wlStatus = e.target.value;
  wlPage   = 1;
  wlRenderTable();
});

document.getElementById('wl-sort-by').addEventListener('change', (e) => {
  const newSort = e.target.value;
  if (newSort === wlSortBy) {
    wlSortDir = wlSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    wlSortBy  = newSort;
    wlSortDir = ['requeuedToday', 'lastRequeuedAt'].includes(newSort) ? 'desc' : 'asc';
  }
  wlPage = 1;
  wlRenderTable();
});

document.getElementById('wl-prev').addEventListener('click', () => {
  if (wlPage > 1) { wlPage--; wlRenderTable(); }
});
document.getElementById('wl-next').addEventListener('click', () => {
  if (wlPage < wlTotalPages) { wlPage++; wlRenderTable(); }
});

// ─── Page lifecycle (called by app.js showPage) ───────────────────────────────
async function onWatchlistPageShow() {
  wlConnectSSE();
  await wlLoadAll();
  // Tick "last poll X s ago" every second
  if (wlPollTimer) clearInterval(wlPollTimer);
  wlPollTimer = setInterval(wlTickPollBar, 1000);
}

function onWatchlistPageHide() {
  wlDisconnectSSE();
}
