// ─── Position Accuracy Controller ─────────────────────────────────────────────
// Loads and renders the position tracking table.

const POS_TRACKING_PER = 50;
let posTrackingPage    = 1;
let posTrackingTotal   = 0;

// Maps a row's outcome (from the API) to a colored status chip — replaces the
// old blanket "pending" so the report names the exact cause.
const OUTCOME_TONE = {
  ok:    'var(--green)',
  warn:  '#f5a623',
  bad:   'var(--red)',
  info:  'var(--teal, #2dd4bf)',
  muted: 'var(--muted2)',
};
function outcomeCell(outcome) {
  if (!outcome) return '<span style="color:var(--muted2);">—</span>';
  const color = OUTCOME_TONE[outcome.tone] || 'var(--muted2)';
  return `<span style="font-weight:600;color:${color};">${esc(outcome.label || outcome.status || '—')}</span>`;
}

async function loadPosTracking(page = 1) {
  posTrackingPage = page;
  const offset = (page - 1) * POS_TRACKING_PER;
  const tbody  = document.getElementById('pos-tracking-body');

  try {
    const data = await api(`/api/admin/position-tracking?limit=${POS_TRACKING_PER}&offset=${offset}`);
    if (!data) return;

    posTrackingTotal = data.total;

    if (!data.records.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted2);padding:32px;">No records yet — position-schedule bots haven\'t fired.</td></tr>';
      setPosTrackingPagination(0);
      return;
    }

    tbody.innerHTML = data.records.map(r => {
      const firedAt   = r.fired_at ? new Date(r.fired_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
      const target    = r.target_position ?? '—';
      const actual    = r.actual_position ?? '—';
      const diff      = (r.actual_position != null && r.target_position != null)
        ? r.actual_position - r.target_position
        : null;

      // Landed → show the ±diff; otherwise show the EXACT cause (locked out,
      // already in queue, not eligible, missed, waiting…) instead of "pending".
      let diffCell;
      if (diff !== null) {
        const sign  = diff > 0 ? '+' : '';
        const color = Math.abs(diff) <= 10 ? 'var(--green)' : Math.abs(diff) <= 25 ? 'var(--amber)' : 'var(--red)';
        diffCell = `<span style="font-weight:700;color:${color};">${sign}${diff}</span>`;
      } else {
        diffCell = outcomeCell(r.outcome);
      }

      const growthRate    = r.growth_rate != null ? Number(r.growth_rate).toFixed(1) + '/tick' : '—';
      const estimDrift    = r.estimated_drift ?? '—';
      const queueAtFire   = r.queue_size_at_fire ?? '—';

      return `
        <tr>
          <td style="font-size:12px;color:var(--muted2);white-space:nowrap;">${esc(firedAt)}</td>
          <td>
            <div style="font-weight:600;">${esc(r.driver_name)}</div>
          </td>
          <td><span class="mono">${esc(r.vehicle_number)}</span></td>
          <td style="font-weight:700;color:var(--teal);">${target}</td>
          <td style="color:var(--muted2);">${queueAtFire}</td>
          <td style="color:var(--muted2);">${estimDrift}</td>
          <td style="color:var(--muted2);">${growthRate}</td>
          <td style="font-weight:600;">${actual}</td>
          <td>${diffCell}</td>
        </tr>`;
    }).join('');

    setPosTrackingPagination(data.total);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--red);text-align:center;padding:24px;">${err.message}</td></tr>`;
  }
}

function setPosTrackingPagination(total) {
  const pag      = document.getElementById('pos-tracking-pagination');
  const info     = document.getElementById('pos-tracking-page-info');
  const prevBtn  = document.getElementById('pos-tracking-prev');
  const nextBtn  = document.getElementById('pos-tracking-next');
  const pages    = Math.ceil(total / POS_TRACKING_PER);

  pag.style.display = total > POS_TRACKING_PER ? 'flex' : 'none';
  info.textContent   = `Page ${posTrackingPage} of ${pages} (${total} records)`;
  prevBtn.disabled   = posTrackingPage <= 1;
  nextBtn.disabled   = posTrackingPage >= pages;
}

document.getElementById('pos-tracking-prev').addEventListener('click', () => loadPosTracking(posTrackingPage - 1));
document.getElementById('pos-tracking-next').addEventListener('click', () => loadPosTracking(posTrackingPage + 1));

// ─── Overnight Carryover Removals report ──────────────────────────────────────
// Shows leftover drivers pulled from yesterday's queue at the midnight reset and
// whether they then landed at today's target. The proof the carryover fix works.
const fmtPT = (ts) => ts
  ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
  : '—';

async function loadCarryoverReport(date) {
  const tbody = document.getElementById('carryover-body');
  const picker = document.getElementById('carryover-date');
  const d = date || (picker && picker.value) || 'today';
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:24px;">Loading…</td></tr>';

  try {
    const data = await api(`/api/admin/reports/carryover/${encodeURIComponent(d)}`);
    if (!data) return;
    if (picker && !picker.value) picker.value = data.date; // sync the date input to the resolved PT day

    if (!data.records.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:28px;">No carryover removals on ${esc(data.date)} — no drivers were left in yesterday's queue.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.records.map((r) => {
      const target = r.target_position ?? '—';
      const landed = r.actual_position ?? null;
      const removedOk = r.removal_status === 'success';
      const landedAt = r.landed_at || r.fired_at;

      let landedCell = '<span style="color:var(--muted2);">—</span>';
      let diffCell   = outcomeCell(r.outcome);   // exact cause when no clean landing
      if (landed != null && r.target_position != null) {
        const diff  = landed - r.target_position;
        const sign  = diff > 0 ? '+' : '';
        const color = Math.abs(diff) <= 10 ? 'var(--green)' : Math.abs(diff) <= 25 ? 'var(--amber)' : 'var(--red)';
        landedCell  = `<span style="font-weight:600;">${landed}</span>`;
        diffCell    = `<span style="font-weight:700;color:${color};">${sign}${diff}</span>`;
      } else if (landed != null) {
        landedCell = `<span style="font-weight:600;">${landed}</span>`;
      }

      return `
        <tr>
          <td><div style="font-weight:600;">${esc(r.driver_name)}</div></td>
          <td><span class="mono">${esc(r.vehicle_number)}</span></td>
          <td style="font-size:12px;color:${removedOk ? 'var(--green)' : 'var(--red)'};white-space:nowrap;">
            ${removedOk ? '✓ ' : '✗ '}${esc(fmtPT(r.removed_at))}
          </td>
          <td style="font-weight:700;color:var(--teal);">${target}</td>
          <td>${landedCell}</td>
          <td style="font-size:12px;color:var(--muted2);white-space:nowrap;">${esc(fmtPT(landedAt))}</td>
          <td>${diffCell}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`;
  }
}

const carryoverDateEl = document.getElementById('carryover-date');
if (carryoverDateEl) carryoverDateEl.addEventListener('change', () => loadCarryoverReport(carryoverDateEl.value));
