// ─── Terminal Dwell & Requeue-Latency metrics (T1 vs T2 diagnostics) ──────────
// Loads /api/admin/terminal-metrics and renders one row per terminal trip, plus
// a 7-day summary strip. Registered for search + Terminal filter in tableFilter.js.
// Depends on global helpers: api, esc (utils.js).

const TERMINAL_METRICS_PER = 50;
let terminalMetricsPage = 1;

// Seconds → "2m 15s" / "45s" / "1h 3m".
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

const fmtPTFull = (ts) => ts
  ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
  : '—';

function terminalBadge(t) {
  if (t === 'T1') return '<span class="badge" style="color:var(--amber);background:rgba(245,166,35,0.12);">T1</span>';
  if (t === 'T2') return '<span class="badge" style="color:var(--teal);background:rgba(0,209,178,0.12);">T2</span>';
  return '<span class="badge inactive">—</span>';
}

const PATH_LABELS = {
  left_terminal:     'Left terminal',
  timeout:           'Timeout (never seen)',
  san_auto_returned: 'SAN auto-returned',
};

function renderTerminalSummary(summary) {
  const el = document.getElementById('terminal-metrics-summary');
  if (!el) return;
  if (!summary || !summary.length) { el.textContent = ''; return; }
  const order = { T1: 0, T2: 1, unknown: 2 };
  const parts = [...summary]
    .sort((a, b) => (order[a.terminal] ?? 9) - (order[b.terminal] ?? 9))
    .map((s) => `${esc(s.terminal)}: ${s.trips} trips · median dwell ${fmtDur(s.medianDwell)} · avg lag ${fmtDur(s.avgLag)}`);
  el.innerHTML = `Last 7 days — ${parts.join('  |  ')}`;
}

async function loadTerminalMetrics(page = 1) {
  terminalMetricsPage = page;
  const offset = (page - 1) * TERMINAL_METRICS_PER;
  const tbody  = document.getElementById('terminal-metrics-body');
  if (!tbody) return;

  try {
    const data = await api(`/api/admin/terminal-metrics?limit=${TERMINAL_METRICS_PER}&offset=${offset}`);
    if (!data) return;

    renderTerminalSummary(data.summary);

    if (!data.records.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:32px;">No terminal trips recorded yet.</td></tr>';
      setTerminalMetricsPagination(0);
      return;
    }

    tbody.innerHTML = data.records.map((r) => {
      const dwell = r.dwell_seconds;
      const lag   = r.detection_lag_seconds;
      // Colour the detection lag: green ≤2 min, amber ≤6 min, red beyond.
      const lagColor = lag == null ? 'var(--muted2)'
        : lag <= 120 ? 'var(--green)' : lag <= 360 ? 'var(--amber)' : 'var(--red)';
      return `
        <tr>
          <td style="font-size:12px;color:var(--muted2);white-space:nowrap;">${esc(fmtPTFull(r.requeued_at))}</td>
          <td><span class="mono" style="font-weight:700;">${esc(r.vehicle_number)}</span></td>
          <td style="font-weight:500;">${esc(r.driver_name || '—')}</td>
          <td>${terminalBadge(r.terminal)}</td>
          <td style="font-size:12px;">${esc(PATH_LABELS[r.requeue_path] || r.requeue_path || '—')}</td>
          <td style="font-weight:600;">${fmtDur(dwell)}</td>
          <td style="font-weight:600;color:${lagColor};">${fmtDur(lag)}</td>
        </tr>`;
    }).join('');

    setTerminalMetricsPagination(data.total);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`;
  }
}

function setTerminalMetricsPagination(total) {
  const pag     = document.getElementById('terminal-metrics-pagination');
  const info    = document.getElementById('terminal-metrics-page-info');
  const prevBtn = document.getElementById('terminal-metrics-prev');
  const nextBtn = document.getElementById('terminal-metrics-next');
  if (!pag) return;
  const pages = Math.ceil(total / TERMINAL_METRICS_PER);

  pag.style.display = total > TERMINAL_METRICS_PER ? 'flex' : 'none';
  info.textContent  = `Page ${terminalMetricsPage} of ${pages} (${total} records)`;
  prevBtn.disabled  = terminalMetricsPage <= 1;
  nextBtn.disabled  = terminalMetricsPage >= pages;
}

document.getElementById('terminal-metrics-prev')?.addEventListener('click', () => loadTerminalMetrics(terminalMetricsPage - 1));
document.getElementById('terminal-metrics-next')?.addEventListener('click', () => loadTerminalMetrics(terminalMetricsPage + 1));
