// ─── Driver Schedule Controller ───────────────────────────────────────────────
// Handles: schedule summary display, per-day schedule modal, credential updates.
// Also wires the day-picker click toggle for both the registration form
// (reg-day-picker) and the schedule page (sched-day-picker).
// Depends on: utils.js (api, showToast, getDayPickerValue, driverProfile)

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Day-picker toggle (registration + schedule pages) ───────────────────────
['reg-day-picker', 'sched-day-picker'].forEach(pickerId => {
  const picker = document.getElementById(pickerId);
  if (picker) {
    picker.addEventListener('click', e => {
      const btn = e.target.closest('.day-btn');
      if (btn) btn.classList.toggle('active');
    });
  }
});

// ─── Schedule mode toggle ─────────────────────────────────────────────────────
function setSchedMode(mode) {
  const isTime = mode === 'time';
  document.getElementById('sched-time-block').style.display = isTime ? '' : 'none';
  document.getElementById('sched-pos-block').style.display  = isTime ? 'none' : '';
  document.getElementById('sched-type-time').className = isTime ? 'btn btn-primary' : 'btn btn-ghost';
  document.getElementById('sched-type-pos').className  = isTime ? 'btn btn-ghost'   : 'btn btn-primary';
}

document.getElementById('sched-type-time').addEventListener('click', () => setSchedMode('time'));
document.getElementById('sched-type-pos').addEventListener('click',  () => setSchedMode('position'));

// ─── Schedule summary text ────────────────────────────────────────────────────
function renderSchedSummary() {
  const el = document.getElementById('sched-summary');
  if (!driverProfile) { el.textContent = 'Loading…'; return; }

  if (driverProfile.day_positions) {
    try {
      const dp    = JSON.parse(driverProfile.day_positions);
      const lines = [];
      for (let d = 0; d < 7; d++) {
        const p = dp[String(d)];
        if (p) lines.push(
          `<span style="color:var(--white);font-weight:600;">${DAY_SHORT[d]}</span> ` +
          `<span style="color:var(--teal);">~${p}</span>`
        );
      }
      el.innerHTML = lines.length
        ? `📍 ` + lines.join(' &nbsp;·&nbsp; ')
        : '<span style="color:var(--muted);">No active days configured</span>';
      return;
    } catch { /* fall through */ }
  }

  if (driverProfile.scheduled_position) {
    el.innerHTML = `📍 Position <span style="color:var(--teal);font-weight:700;">${driverProfile.scheduled_position}</span> — bot fires when queue reaches ~${driverProfile.scheduled_position - 3}`;
    return;
  }

  if (driverProfile.day_schedules) {
    try {
      const ds    = JSON.parse(driverProfile.day_schedules);
      const lines = [];
      for (let d = 0; d < 7; d++) {
        const t = ds[String(d)];
        if (t) lines.push(
          `<span style="color:var(--white);font-weight:600;">${DAY_SHORT[d]}</span> ` +
          `<span style="color:var(--teal);">${t}</span> PT`
        );
      }
      el.innerHTML = lines.length
        ? lines.join(' &nbsp;·&nbsp; ')
        : '<span style="color:var(--muted);">No active days configured</span>';
      return;
    } catch { /* fall through to legacy */ }
  }

  // Legacy fallback: single scheduled_time + scheduled_days bitmask
  const time = driverProfile.scheduled_time || '--:--';
  const days = (driverProfile.scheduled_days || '0,1,2,3,4,5,6')
    .split(',')
    .map(n => DAY_SHORT[Number(n)])
    .filter(Boolean);
  el.innerHTML = `<span style="color:var(--teal);font-weight:700;">${time}</span> PT &nbsp;·&nbsp; ${days.join(', ')}`;
}

// ─── Load schedule view ───────────────────────────────────────────────────────
function loadSchedule() {
  if (!driverProfile) return;
  renderSchedSummary();
  document.getElementById('sched-san-username').value = '';
  document.getElementById('sched-san-password').value = '';
  document.getElementById('sched-vehicle').value      = '';

  if (driverProfile.day_positions || driverProfile.scheduled_position) {
    setSchedMode('position');
  } else {
    setSchedMode('time');
  }
}

// ─── Per-day position modal ───────────────────────────────────────────────────
function buildDayPositionRows(dayPositions) {
  const container = document.getElementById('pos-schedule-rows');
  container.innerHTML = '';

  for (let d = 0; d < 7; d++) {
    const key    = String(d);
    const pos    = dayPositions[key];
    const active = pos !== null && pos !== undefined;
    const row    = document.createElement('div');
    row.className = 'day-sched-row';
    row.innerHTML = `
      <div class="day-sched-toggle ${active ? 'on' : ''}" data-day="${d}"></div>
      <span class="day-sched-name">${DAY_NAMES[d]}</span>
      <input type="number" class="day-sched-time" data-day="${d}"
             value="${pos || 200}" min="1" step="1" placeholder="e.g. 200" inputmode="numeric"
             ${active ? '' : 'disabled'}>
    `;
    container.appendChild(row);

    row.querySelector('.day-sched-toggle').addEventListener('click', function () {
      this.classList.toggle('on');
      const input   = row.querySelector('input[type="number"]');
      input.disabled = !this.classList.contains('on');
    });
  }
}

function readDayPositionRows() {
  const dp = {};
  document.querySelectorAll('#pos-schedule-rows .day-sched-row').forEach(row => {
    const toggle = row.querySelector('.day-sched-toggle');
    const input  = row.querySelector('input[type="number"]');
    const d      = toggle.dataset.day;
    dp[d] = toggle.classList.contains('on') ? (parseInt(input.value, 10) || null) : null;
  });
  return JSON.stringify(dp);
}

function openPosScheduleModal(profile) {
  let dp = {};
  const dayPositionsStr = typeof profile === 'string'
    ? profile
    : (profile && profile.day_positions);

  if (dayPositionsStr) {
    try { dp = JSON.parse(dayPositionsStr); } catch {}
  }

  buildDayPositionRows(dp);
  document.getElementById('pos-schedule-modal').classList.add('open');
}

// ─── Per-day schedule modal ───────────────────────────────────────────────────
function buildDayScheduleRows(daySchedules) {
  const container = document.getElementById('day-schedule-rows');
  container.innerHTML = '';

  for (let d = 0; d < 7; d++) {
    const key    = String(d);
    const time   = daySchedules[key];
    const active = time !== null && time !== undefined;
    const row    = document.createElement('div');
    row.className = 'day-sched-row';
    row.innerHTML = `
      <div class="day-sched-toggle ${active ? 'on' : ''}" data-day="${d}"></div>
      <span class="day-sched-name">${DAY_NAMES[d]}</span>
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

function readDayScheduleRows() {
  const ds = {};
  document.querySelectorAll('#day-schedule-rows .day-sched-row').forEach(row => {
    const toggle = row.querySelector('.day-sched-toggle');
    const input  = row.querySelector('.day-sched-time');
    const d      = toggle.dataset.day;
    ds[d]        = toggle.classList.contains('on') ? input.value : null;
  });
  return JSON.stringify(ds);
}

function openDayScheduleModal(profile) {
  let ds = {};
  const daySchedulesStr = typeof profile === 'string'
    ? profile
    : (profile && profile.day_schedules);

  if (daySchedulesStr) {
    try { ds = JSON.parse(daySchedulesStr); } catch {}
  } else if (profile && typeof profile === 'object') {
    // Legacy fallback: build from scheduled_days + scheduled_time
    const activeDays = (profile.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
    for (let d = 0; d < 7; d++) {
      ds[String(d)] = activeDays.includes(String(d))
        ? (profile.scheduled_time || '05:00')
        : null;
    }
  }

  buildDayScheduleRows(ds);
  document.getElementById('day-schedule-modal').classList.add('open');
}

// ─── Inline feedback helpers ──────────────────────────────────────────────────
function setError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function showSuccess(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent       = msg;
  el.style.display     = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Open per-day position modal
document.getElementById('btn-open-pos-sched').addEventListener('click', () => {
  openPosScheduleModal(driverProfile || null);
});

// Cancel position modal
document.getElementById('btn-pos-sched-cancel').addEventListener('click', () => {
  document.getElementById('pos-schedule-modal').classList.remove('open');
});

// Save per-day position schedule
document.getElementById('btn-pos-sched-save').addEventListener('click', async () => {
  const modalErr = document.getElementById('pos-sched-modal-error');
  modalErr.style.display = 'none';
  modalErr.textContent   = '';

  const dayPositions = readDayPositionRows();
  const dp           = JSON.parse(dayPositions);
  const hasActive    = Object.values(dp).some(v => v !== null);

  if (!hasActive) {
    modalErr.textContent   = 'Enable at least one day before saving.';
    modalErr.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-pos-sched-save');
  btn.innerHTML = '<span class="spinner"></span> Saving…';
  btn.disabled  = true;

  try {
    setError('sched-error', '');
    // Re-fetch after save so driverProfile always reflects what the server stored
    await api('/api/driver/profile', {
      method: 'PUT',
      body:   JSON.stringify({ dayPositions }),
    });
    driverProfile = await api('/api/driver/profile');

    document.getElementById('pos-schedule-modal').classList.remove('open');
    showSuccess('sched-success', 'Position schedule saved!');
    renderSchedSummary();
    loadSchedule();
  } catch (err) {
    modalErr.textContent   = err.message;
    modalErr.style.display = 'block';
  } finally {
    btn.innerHTML = 'Save Schedule';
    btn.disabled  = false;
  }
});

// Open per-day schedule modal
document.getElementById('btn-open-day-sched').addEventListener('click', () => {
  openDayScheduleModal(driverProfile || null);
});

// Save credentials (SAN username/password, vehicle number)
document.getElementById('btn-save-schedule').addEventListener('click', async () => {
  const sanUsername   = document.getElementById('sched-san-username').value.trim() || undefined;
  const sanPassword   = document.getElementById('sched-san-password').value        || undefined;
  const vehicleNumber = document.getElementById('sched-vehicle').value.trim()      || undefined;
  const errEl         = document.getElementById('sched-error');
  errEl.textContent   = '';

  const btn = document.getElementById('btn-save-schedule');
  btn.innerHTML = '<span class="spinner"></span> Saving…'; btn.disabled = true;

  try {
    const body = {};
    if (sanUsername)   body.sanUsername   = sanUsername;
    if (sanPassword)   body.sanPassword   = sanPassword;
    if (vehicleNumber) body.vehicleNumber = vehicleNumber;

    driverProfile = await api('/api/driver/profile', { method: 'PUT', body: JSON.stringify(body) });
    if (!(driverProfile.day_positions || driverProfile.scheduled_position)) {
      document.getElementById('stat-time').textContent = driverProfile.scheduled_time || '--:--';
    }
    showToast('Credentials updated ✓');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Save Changes'; btn.disabled = false;
  }
});

// Cancel per-day modal
document.getElementById('btn-day-sched-cancel').addEventListener('click', () => {
  document.getElementById('day-schedule-modal').classList.remove('open');
});

// Save per-day schedule
document.getElementById('btn-day-sched-save').addEventListener('click', async () => {
  const daySchedules  = readDayScheduleRows();
  const ds            = JSON.parse(daySchedules);
  const activeDays    = Object.keys(ds).filter(k => ds[k] !== null);
  const times         = activeDays.map(k => ds[k]).filter(Boolean);
  const scheduledTime = times[0] || '05:00';
  const scheduledDays = activeDays.join(',') || '0,1,2,3,4,5,6';

  try {
    setError('sched-error', '');
    driverProfile = await api('/api/driver/profile', {
      method: 'PUT',
      body: JSON.stringify({ daySchedules, scheduledTime, scheduledDays }),
    });
    document.getElementById('day-schedule-modal').classList.remove('open');
    showSuccess('sched-success', 'Schedule saved!');
    renderSchedSummary();
    document.getElementById('stat-time').textContent    = driverProfile.scheduled_time || '--:--';
    document.getElementById('stat-time-lbl').textContent = 'Scheduled Time';
  } catch (err) {
    setError('sched-error', err.message);
  }
});
