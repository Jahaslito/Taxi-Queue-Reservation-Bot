// ─── Queue Monitor Controller ─────────────────────────────────────────────────
// Manages the Monitor page: SSE live feed, watch cards, event log.
// Depends on: utils.js (api, esc, showToast)
// showPage() defined in app.js — only called at runtime, never at parse time.

// ─── State ───────────────────────────────────────────────────────────────────
let monitorSSE     = null;   // EventSource
let monitorWatches = {};     // driverId → state snapshot
let monitorEvents  = [];     // recent requeue_result events (newest first, max 100)
let lastPollStats  = null;
let lastPollTime   = null;   // Date of last poll tick
let pollTickTimer  = null;   // setInterval to update "last poll X s ago"
let sseConnected   = false;

// ─── Time helpers ─────────────────────────────────────────────────────────────
function relTime(iso) {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── State badge ─────────────────────────────────────────────────────────────
function stateBadge(state) {
  const map = {
    watching:   ['var(--muted2)',  '👁',  'WATCHING'],
    in_queue:   ['var(--green)',   '✅', 'IN QUEUE'],
    dispatched: ['var(--amber)',   '🚖', 'DISPATCHED'],
    gone:       ['var(--red)',     '🔴', 'GONE'],
    requeuing:  ['var(--blue)',    '⚡', 'RE-QUEUING'],
  };
  const [color, icon, label] = map[state] || ['var(--muted)', '?', state.toUpperCase()];
  return `<span style="
    display:inline-flex;align-items:center;gap:5px;
    padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
    background:${color}1a;color:${color};border:1px solid ${color}40;">
    ${icon} ${label}
  </span>`;
}

// ─── Render a single watch card ───────────────────────────────────────────────
function renderCard(s) {
  const stateColor = {
    watching:   'var(--muted)',
    in_queue:   'var(--green)',
    dispatched: 'var(--amber)',
    gone:       'var(--red)',
    requeuing:  'var(--blue)',
  }[s.state] || 'var(--muted)';

  // Recent events for this driver
  const driverEvents = monitorEvents.filter(e => e.driverId === s.driverId).slice(0, 5);
  const eventsHtml = driverEvents.length
    ? driverEvents.map(e => {
        const ok     = e.result?.success;
        const pos    = e.result?.position ? ` · pos #${e.result.position}` : '';
        const detail = ok
          ? `✅ Re-queued${pos}`
          : `❌ Failed — ${esc(e.result?.error || 'unknown')}`;
        return `<div style="font-size:12px;color:${ok ? 'var(--green)' : 'var(--red)'};margin-top:6px;">
          <span style="color:var(--muted);margin-right:6px;">${fmtTime(e.ts)}</span>${detail}
        </div>`;
      }).join('')
    : '<div style="font-size:12px;color:var(--muted);margin-top:6px;">No re-queue events yet</div>';

  const posHtml = s.currentPosition != null
    ? `<div title="Last placed at #${s.lastPosition ?? '—'}" style="
        font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;
        color:${stateColor};min-width:60px;text-align:right;cursor:default;">
        #${s.currentPosition}
      </div>`
    : '';

  return `<div class="mon-card" data-driver-id="${s.driverId}" style="
      background:var(--bg2);border:1px solid ${stateColor}40;
      border-left:3px solid ${stateColor};
      border-radius:14px;padding:20px 24px;
      transition:border-color 0.4s;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:700;color:var(--teal);">
          #${esc(s.vehicleNumber)}
        </div>
        ${stateBadge(s.state)}
      </div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${posHtml}
        <button class="btn btn-danger btn-sm" onclick="stopWatching(${s.driverId})">Stop Watching</button>
      </div>
    </div>

    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:14px;font-size:13px;color:var(--muted2);">
      <span>Watching since: <strong style="color:var(--white);">${fmtTime(s.addedAt)}</strong></span>
      ${s.lastSeenAt     ? `<span>Last in queue: <strong style="color:var(--white);">${fmtTime(s.lastSeenAt)}</strong></span>` : ''}
      ${s.lastDispatchAt ? `<span>Dispatched at: <strong style="color:var(--amber);">${fmtTime(s.lastDispatchAt)}</strong></span>` : ''}
      ${s.lastGoneAt     ? `<span>Gone at: <strong style="color:var(--red);">${fmtTime(s.lastGoneAt)}</strong></span>` : ''}
      ${s.lastRequeuedAt ? `<span>Last re-queue: <strong style="color:var(--blue);">${fmtTime(s.lastRequeuedAt)}</strong></span>` : ''}
    </div>

    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:2px;">
        Auto Re-Queue History
      </div>
      ${eventsHtml}
    </div>
  </div>`;
}

// ─── Render all watch cards (only manually-pinned drivers) ───────────────────
function renderWatches() {
  const wrap   = document.getElementById('monitor-watches');
  const empty  = document.getElementById('monitor-empty');
  const evWrap = document.getElementById('monitor-events-wrap');
  // Only show cards for drivers explicitly added via "Watch Vehicle"
  const states = Object.values(monitorWatches).filter(s => s.isManual);

  if (!states.length) {
    wrap.innerHTML       = '';
    empty.style.display  = 'block';
    evWrap.style.display = 'none';
    return;
  }

  empty.style.display  = 'none';
  evWrap.style.display = 'block';
  wrap.innerHTML = states.map(renderCard).join('');
}

// ─── Patch a single card in-place (avoid full re-render on every poll tick) ──
function patchCard(driverId) {
  const state = monitorWatches[driverId];
  if (!state || !state.isManual) return; // only manually-pinned drivers have cards
  const existing = document.querySelector(`.mon-card[data-driver-id="${driverId}"]`);
  if (existing) {
    const el = document.createElement('div');
    el.innerHTML = renderCard(state);
    existing.replaceWith(el.firstElementChild);
  } else {
    renderWatches(); // fallback: full re-render
  }
}

// ─── Events table ─────────────────────────────────────────────────────────────
function renderEventsTable() {
  const tbody = document.getElementById('monitor-events-body');
  if (!monitorEvents.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:20px;">No events yet</td></tr>';
    return;
  }
  tbody.innerHTML = monitorEvents.slice(0, 50).map(e => {
    const ok     = e.result?.success;
    const pos    = e.result?.position || '—';
    const detail = e.result?.error || e.result?.message || (ok ? 'Success' : 'Failed');
    return `<tr>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;">${fmtTime(e.ts)}</td>
      <td><strong style="color:var(--teal);font-family:'IBM Plex Mono',monospace;">#${esc(e.vehicleNumber)}</strong></td>
      <td>${esc(e.driverName || '—')}</td>
      <td>${ok
        ? '<span class="badge success"><span class="badge-dot"></span>Success</span>'
        : '<span class="badge failed"><span class="badge-dot"></span>Failed</span>'}</td>
      <td style="font-family:'IBM Plex Mono',monospace;">${esc(String(pos))}</td>
      <td style="font-size:12px;color:var(--muted2);">${esc(detail)}</td>
    </tr>`;
  }).join('');
}

// ─── Operating hours banner ───────────────────────────────────────────────────
function updateHoursBanner(oh) {
  if (!oh) return;
  let banner = document.getElementById('mon-hours-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mon-hours-banner';
    banner.style.cssText = [
      'display:none', 'align-items:center', 'gap:10px',
      'padding:10px 18px', 'border-radius:10px', 'margin-bottom:16px',
      'background:var(--amber)1a', 'border:1px solid var(--amber)40',
      'color:var(--amber)', 'font-size:13px', 'font-weight:600',
    ].join(';');
    const statusBar = document.getElementById('monitor-status-bar');
    if (statusBar) statusBar.after(banner);
  }
  if (oh.active) {
    banner.style.display = 'none';
  } else {
    banner.style.display = 'flex';
    banner.textContent = `⏸ Auto-requeue paused — outside operating hours (${oh.startHour}:00–${oh.endHour}:00 PT). Resumes at ${oh.startHour}:00 AM PT.`;
  }
}

// ─── Status bar update ────────────────────────────────────────────────────────
function updateStatusBar() {
  if (lastPollStats) {
    document.getElementById('mon-waiting').textContent    = lastPollStats.waiting ?? '—';
    document.getElementById('mon-dispatched').textContent = lastPollStats.dispatched ?? '—';
    document.getElementById('mon-fetch-ms').textContent   =
      lastPollStats.fetchMs != null ? `${lastPollStats.fetchMs}ms` : '—';
    if (lastPollStats.queueUrl) {
      document.getElementById('mon-queue-url').textContent = lastPollStats.queueUrl;
    }
  }
  if (lastPollTime) {
    document.getElementById('mon-last-poll').textContent = relTime(lastPollTime);
  }
}

// ─── SSE live connection ──────────────────────────────────────────────────────
function connectSSE() {
  if (monitorSSE) { monitorSSE.close(); monitorSSE = null; }

  const dot   = document.getElementById('mon-dot');
  const label = document.getElementById('mon-live-label');
  const navDot = document.getElementById('monitor-live-dot');

  function setConnected(ok) {
    sseConnected = ok;
    dot.style.background   = ok ? 'var(--green)' : 'var(--red)';
    dot.style.boxShadow    = ok ? '0 0 6px var(--green)' : 'none';
    label.textContent      = ok ? 'Live' : 'Reconnecting…';
    label.style.color      = ok ? 'var(--green)' : 'var(--red)';
    if (navDot) navDot.style.display = ok ? 'inline-block' : 'none';
  }

  monitorSSE = new EventSource('/api/admin/monitor/stream', { withCredentials: true });

  monitorSSE.onopen = () => setConnected(true);

  monitorSSE.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {

      case 'init': {
        // Full state on connection — populate everything
        const p = msg.payload;
        lastPollStats = p.pollStats;
        lastPollTime  = p.pollStats?.pollAt ? new Date(p.pollStats.pollAt) : null;
        monitorWatches = {};
        (p.watches || []).forEach(w => { monitorWatches[w.driverId] = w; });
        document.getElementById('mon-queue-url').textContent = p.queueUrl || '';
        renderWatches();
        updateStatusBar();
        if (p.operatingHours) updateHoursBanner(p.operatingHours);
        break;
      }

      case 'poll': {
        lastPollStats = msg.payload;
        lastPollTime  = new Date();
        updateStatusBar();
        if (msg.payload?.operatingHours) updateHoursBanner(msg.payload.operatingHours);
        break;
      }

      case 'poll_error': {
        document.getElementById('mon-last-poll').textContent = '⚠ Poll error';
        break;
      }

      case 'driver_state': {
        const { driverId, state } = msg.payload;
        monitorWatches[driverId] = state;
        patchCard(driverId);
        break;
      }

      case 'watch_added': {
        const { driverId, state } = msg.payload;
        monitorWatches[driverId] = state;
        renderWatches();
        break;
      }

      case 'watch_removed': {
        delete monitorWatches[msg.payload.driverId];
        renderWatches();
        break;
      }

      case 'requeue_triggered': {
        showToast(`⚡ Re-queuing #${msg.payload.vehicleNumber}…`, 'success', 3000);
        break;
      }

      case 'requeue_result': {
        const ev = {
          driverId:      msg.payload.driverId,
          driverName:    msg.payload.driverName || '—',
          vehicleNumber: msg.payload.vehicleNumber,
          result:        msg.payload.result,
          ts:            msg.ts ? new Date(msg.ts) : new Date(),
        };
        monitorEvents.unshift(ev);
        if (monitorEvents.length > 100) monitorEvents.length = 100;

        const ok = msg.payload.result?.success;
        showToast(
          ok
            ? `✅ #${ev.vehicleNumber} re-queued at position #${msg.payload.result.position || '?'}`
            : `❌ Re-queue failed for #${ev.vehicleNumber}`,
          ok ? 'success' : 'error',
          5000,
        );

        // Patch the card + refresh events table
        patchCard(ev.driverId);
        renderEventsTable();
        document.getElementById('monitor-events-wrap').style.display = 'block';
        break;
      }
    }
  };

  monitorSSE.onerror = () => {
    setConnected(false);
    // Auto-reconnect after 5s (browser EventSource retries automatically,
    // but we also refresh the connection to get a fresh cookie check)
    setTimeout(() => {
      if (document.getElementById('page-monitor')?.classList.contains('active')) {
        connectSSE();
      }
    }, 5000);
  };
}

function disconnectSSE() {
  if (monitorSSE) { monitorSSE.close(); monitorSSE = null; }
  if (pollTickTimer) { clearInterval(pollTickTimer); pollTickTimer = null; }
  const navDot = document.getElementById('monitor-live-dot');
  if (navDot) navDot.style.display = 'none';
}

// ─── Add watch flow ───────────────────────────────────────────────────────────
async function startWatchPrompt() {
  const raw = prompt('Enter vehicle number to watch (e.g. 4007):');
  if (!raw || !raw.trim()) return;
  const vehicleNumber = raw.trim();

  try {
    const data = await api('/api/admin/monitor/watch', {
      method: 'POST',
      body: JSON.stringify({ vehicleNumber }),
    });
    showToast(`👁 Now watching #${vehicleNumber}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopWatching(driverId) {
  try {
    await api(`/api/admin/monitor/watch/${driverId}`, { method: 'DELETE' });
    showToast('Stopped watching', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Page lifecycle (called by app.js showPage) ───────────────────────────────
function onMonitorPageShow() {
  connectSSE();
  // Tick every second to keep "last poll X s ago" fresh
  if (pollTickTimer) clearInterval(pollTickTimer);
  pollTickTimer = setInterval(updateStatusBar, 1000);
}

function onMonitorPageHide() {
  disconnectSSE();
}

// ─── Event listeners ─────────────────────────────────────────────────────────
document.getElementById('btn-add-watch').addEventListener('click', startWatchPrompt);
