// ─── Admin Scheduled-Drivers Modal Controller ────────────────────────────────
// Handles the "View Drivers" popup from the schedule breakdown table.
// Exposes: openSchedDriversModal (called by overview.controller.js)
// Depends on: utils.js (api, esc, showToast)

const SDF_PER_PAGE = 10;

let sdfAllDrivers = [];
let sdfFiltered   = [];
let sdfPage       = 1;

// ─── Today's day index (0 = Sun … 6 = Sat) in Los Angeles time ───────────────
function todayDayIndex() {
  const abbr   = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return String(dayMap[abbr]);
}

// ─── Resolve what time a driver is scheduled for today ───────────────────────
// Returns the per-day time if configured, or the legacy scheduled_time.
// Returns '—' if the driver is not scheduled today.
function effectiveTime(driver) {
  const d = todayDayIndex();
  if (driver.day_schedules) {
    try {
      const ds = JSON.parse(driver.day_schedules);
      // Return the time for today, or '—' if the driver is not scheduled today.
      // Do NOT fall back to scheduled_time — that field may reflect a different day.
      return ds[d] || '—';
    } catch {}
  }
  // Legacy: check scheduled_days before using scheduled_time
  const activeDays = (driver.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
  if (!activeDays.includes(d)) return '—';
  return driver.scheduled_time || '—';
}

// ─── Open the modal, fetch all active drivers, apply initial time filter ──────
async function openSchedDriversModal(time) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  document.getElementById('sdf-subtitle').textContent  = `${time} PT  ·  ${dateStr} PT`;
  document.getElementById('sdf-filter-name').value     = '';
  document.getElementById('sdf-filter-car').value      = '';
  document.getElementById('sdf-filter-time').value     = time;
  document.getElementById('sdf-tbody').innerHTML       =
    '<tr><td colspan="4" style="text-align:center;color:var(--muted2);padding:28px;"><span class="spinner"></span></td></tr>';
  document.getElementById('sdf-count').textContent     = '';
  document.getElementById('sdf-page-info').textContent = '';
  document.getElementById('modal-sched-drivers').classList.add('open');

  try {
    const data    = await api('/api/admin/drivers?active=true&limit=500');
    sdfAllDrivers = data?.drivers || [];
    sdfPage       = 1;
    applySDFFilters();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Filter sdfAllDrivers by name, vehicle, and scheduled time ───────────────
function applySDFFilters() {
  const name = document.getElementById('sdf-filter-name').value.toLowerCase().trim();
  const car  = document.getElementById('sdf-filter-car').value.toLowerCase().trim();
  const time = document.getElementById('sdf-filter-time').value.trim();

  sdfFiltered = sdfAllDrivers.filter(d => {
    if (name && !d.name.toLowerCase().includes(name))               return false;
    if (car  && !d.vehicle_number.toLowerCase().includes(car))      return false;
    if (time && !effectiveTime(d).includes(time))                   return false;
    return true;
  });

  sdfPage = 1;
  renderSDFPage();
}

// ─── Render current page of filtered results ──────────────────────────────────
function renderSDFPage() {
  const tbody = document.getElementById('sdf-tbody');
  const total = sdfFiltered.length;
  const pages = Math.max(1, Math.ceil(total / SDF_PER_PAGE));
  const start = (sdfPage - 1) * SDF_PER_PAGE;
  const slice = sdfFiltered.slice(start, start + SDF_PER_PAGE);

  document.getElementById('sdf-count').textContent     = `${total} driver${total !== 1 ? 's' : ''} found`;
  document.getElementById('sdf-page-info').textContent = `Page ${sdfPage} of ${pages}`;
  document.getElementById('sdf-prev').disabled         = sdfPage <= 1;
  document.getElementById('sdf-next').disabled         = sdfPage >= pages;

  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted2);padding:28px;">No drivers match your filters</td></tr>';
    return;
  }

  tbody.innerHTML = slice.map((d, i) => `
    <tr style="border-bottom:1px solid var(--border);${i % 2 === 0 ? '' : 'background:rgba(255,255,255,0.015);'}">
      <td style="padding:12px 14px;font-weight:600;">${esc(d.name)}</td>
      <td style="padding:12px 14px;color:var(--muted2);font-size:13px;">${esc(d.phone || '—')}</td>
      <td style="padding:12px 14px;font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--white);">${esc(d.vehicle_number)}</td>
      <td style="padding:12px 14px;font-family:'IBM Plex Mono',monospace;font-weight:700;color:var(--teal);">${esc(effectiveTime(d))} <span style="color:var(--muted2);font-weight:400;font-family:'DM Sans',sans-serif;font-size:12px;">PT</span></td>
    </tr>`).join('');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Close button
document.getElementById('btn-close-sdf').addEventListener('click', () => {
  document.getElementById('modal-sched-drivers').classList.remove('open');
});

// Click outside the modal to close
document.getElementById('modal-sched-drivers').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// Filter inputs — re-apply on every keystroke
['sdf-filter-name', 'sdf-filter-car', 'sdf-filter-time'].forEach(id => {
  document.getElementById(id).addEventListener('input', applySDFFilters);
});

// Pagination
document.getElementById('sdf-prev').addEventListener('click', () => {
  if (sdfPage > 1) { sdfPage--; renderSDFPage(); }
});
document.getElementById('sdf-next').addEventListener('click', () => {
  const pages = Math.ceil(sdfFiltered.length / SDF_PER_PAGE);
  if (sdfPage < pages) { sdfPage++; renderSDFPage(); }
});
