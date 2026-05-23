// ─── Position Accuracy Controller ─────────────────────────────────────────────
// Loads and renders the position tracking table.

const POS_TRACKING_PER = 50;
let posTrackingPage    = 1;
let posTrackingTotal   = 0;

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

      let diffCell = '<span style="color:var(--muted2);">pending</span>';
      if (diff !== null) {
        const sign  = diff > 0 ? '+' : '';
        const color = Math.abs(diff) <= 10 ? 'var(--green)' : Math.abs(diff) <= 25 ? 'var(--amber)' : 'var(--red)';
        diffCell = `<span style="font-weight:700;color:${color};">${sign}${diff}</span>`;
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
