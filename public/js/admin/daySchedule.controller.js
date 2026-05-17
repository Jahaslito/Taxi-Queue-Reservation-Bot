// ─── Admin Day-Schedule Controller ───────────────────────────────────────────
// Handles the per-day schedule modal inside the Add/Edit Driver form.
// Exposes: openAdminDayScheduleModal, renderAdminSchedSummary
// Shares state via: adminCurrentDaySchedules (read/written by drivers.controller.js)
// Depends on: utils.js (nothing from it directly, but must load after utils.js)

const DAY_NAMES_ADMIN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT_ADMIN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Holds the current day_schedules JSON string being edited in the driver modal.
// Written by the Confirm button; read by drivers.controller.js when saving.
let adminCurrentDaySchedules = null;

// ─── Build the 7-row toggle + time-input grid ─────────────────────────────────
function buildAdminDayScheduleRows(daySchedules) {
  const container = document.getElementById('admin-day-schedule-rows');
  container.innerHTML = '';

  for (let d = 0; d < 7; d++) {
    const key    = String(d);
    const time   = daySchedules[key];
    const active = time !== null && time !== undefined;
    const row    = document.createElement('div');
    row.className = 'day-sched-row';
    row.innerHTML = `
      <div class="day-sched-toggle ${active ? 'on' : ''}" data-day="${d}"></div>
      <span class="day-sched-name">${DAY_NAMES_ADMIN[d]}</span>
      <input type="time" class="day-sched-time" data-day="${d}" value="${time || '05:00'}" ${active ? '' : 'disabled'}>
    `;
    container.appendChild(row);

    row.querySelector('.day-sched-toggle').addEventListener('click', function () {
      this.classList.toggle('on');
      const input   = row.querySelector('.day-sched-time');
      input.disabled = !this.classList.contains('on');
    });
  }
}

// ─── Read the modal back into a JSON string ───────────────────────────────────
function readAdminDayScheduleRows() {
  const ds = {};
  document.querySelectorAll('#admin-day-schedule-rows .day-sched-row').forEach(row => {
    const toggle = row.querySelector('.day-sched-toggle');
    const input  = row.querySelector('.day-sched-time');
    const d      = toggle.dataset.day;
    ds[d]        = toggle.classList.contains('on') ? input.value : null;
  });
  return JSON.stringify(ds);
}

// ─── Open the per-day modal pre-populated with current schedule ───────────────
function openAdminDayScheduleModal(currentDaySchedules) {
  let ds = {};
  if (currentDaySchedules) {
    try { ds = JSON.parse(currentDaySchedules); } catch {}
  }
  buildAdminDayScheduleRows(ds);
  document.getElementById('admin-day-schedule-modal').classList.add('open');
}

// ─── Render "Mon 05:00 · Tue 06:00 …" summary line in the driver form ─────────
function renderAdminSchedSummary(daySchedulesJson) {
  const el = document.getElementById('admin-sched-summary');
  if (!el) return;
  if (!daySchedulesJson) { el.textContent = 'No per-day schedule configured'; return; }
  try {
    const ds    = JSON.parse(daySchedulesJson);
    const parts = [];
    for (let d = 0; d < 7; d++) {
      const t = ds[String(d)];
      if (t) parts.push(`${DAY_SHORT_ADMIN[d]} ${t}`);
    }
    el.textContent = parts.length ? parts.join(' · ') + ' PT' : 'No active days';
  } catch { el.textContent = ''; }
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Open the per-day modal from the driver form
document.getElementById('btn-open-admin-day-sched').addEventListener('click', () => {
  openAdminDayScheduleModal(adminCurrentDaySchedules);
});

// Cancel without saving
document.getElementById('btn-admin-day-sched-cancel').addEventListener('click', () => {
  document.getElementById('admin-day-schedule-modal').classList.remove('open');
});

// Confirm — write back to adminCurrentDaySchedules and update the summary
document.getElementById('btn-admin-day-sched-confirm').addEventListener('click', () => {
  adminCurrentDaySchedules = readAdminDayScheduleRows();
  renderAdminSchedSummary(adminCurrentDaySchedules);
  document.getElementById('admin-day-schedule-modal').classList.remove('open');
});
