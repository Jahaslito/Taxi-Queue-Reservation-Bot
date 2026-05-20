// ─── Admin Drivers Controller ─────────────────────────────────────────────────
// Handles: driver list, add/edit modal, save driver, trigger driver,
//          confirm dialog, temp-password reveal.
// Depends on: utils.js (api, esc, showToast)
//             daySchedule.controller.js (adminCurrentDaySchedules,
//               renderAdminSchedSummary, openAdminDayScheduleModal)

// ─── Relative-time formatter (used in the driver table) ──────────────────────
function formatRelTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const h    = Math.floor(diff / 3600000);
  const m    = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)  return `${h}h ago`;
  return `${m}m ago`;
}

// ─── Pagination state ────────────────────────────────────────────────────────
let driversPage   = 1;
const DRIVERS_PER = 25;

function setDriversPagination(total) {
  const bar        = document.getElementById('drivers-pagination');
  const info       = document.getElementById('drivers-page-info');
  const label      = document.getElementById('drivers-page-label');
  const prevBtn    = document.getElementById('drivers-prev');
  const nextBtn    = document.getElementById('drivers-next');
  const totalPages = Math.ceil(total / DRIVERS_PER) || 1;
  const from       = Math.min((driversPage - 1) * DRIVERS_PER + 1, total);
  const to         = Math.min(driversPage * DRIVERS_PER, total);

  bar.style.display = total > 0 ? 'flex' : 'none';
  info.textContent  = total > 0 ? `Showing ${from}–${to} of ${total} driver${total !== 1 ? 's' : ''}` : '';
  label.textContent = `Page ${driversPage} of ${totalPages}`;
  prevBtn.disabled  = driversPage <= 1;
  nextBtn.disabled  = driversPage >= totalPages;
}

// ─── Load and render the driver table ────────────────────────────────────────
async function loadDrivers(page) {
  if (page !== undefined) driversPage = page;
  const offset = (driversPage - 1) * DRIVERS_PER;
  const search = document.getElementById('driver-search').value;
  const tbody  = document.getElementById('drivers-table-body');

  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:24px;"><span class="spinner"></span></td></tr>';
  document.getElementById('drivers-pagination').style.display = 'none';

  try {
    const data = await api(`/api/admin/drivers?limit=${DRIVERS_PER}&offset=${offset}&search=${encodeURIComponent(search)}`);
    if (!data) return; // 401 already handled by api()

    if (!data.drivers.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:32px;">No drivers found</td></tr>';
      setDriversPagination(0);
      return;
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    tbody.innerHTML = data.drivers.map(d => {
      const statusCls   = { success: 'success', already_queued: 'queued', failed: 'failed', pending: 'pending' }[d.last_status] || 'inactive';
      const statusLbl   = d.last_status ? d.last_status.replace('_', ' ') : 'never run';
      const activeBadge = d.is_active
        ? '<span class="badge success"><span class="badge-dot"></span>Active</span>'
        : '<span class="badge inactive">Inactive</span>';
      const isPosSched = !!(d.scheduled_position || d.day_positions);
      const schedCell  = isPosSched
        ? `<span style="color:var(--amber);">📍 Position</span>`
        : `<span style="font-family:'IBM Plex Mono',monospace;color:var(--teal);">${esc(d.scheduled_time || '--')}</span> <span style="font-size:11px;color:var(--muted);">PT</span>`;
      let activeDaysLabel;
      if (isPosSched) {
        try {
          const dp = JSON.parse(d.day_positions || '{}');
          const active = Object.keys(dp).filter(k => dp[k] !== null && dp[k] !== undefined).sort((a, b) => Number(a) - Number(b));
          activeDaysLabel = active.map(k => dayNames[Number(k)]).filter(Boolean).join(', ') || '—';
        } catch { activeDaysLabel = '—'; }
      } else {
        activeDaysLabel = (d.scheduled_days || '0,1,2,3,4,5,6').split(',').map(n => dayNames[Number(n)]).filter(Boolean).join(', ');
      }

      return `
        <tr>
          <td>
            <div style="font-weight:600;">${esc(d.name)}</div>
            <div style="font-size:12px;color:var(--muted2);">${esc(d.san_username)}</div>
          </td>
          <td><span class="mono">${esc(d.vehicle_number)}</span></td>
          <td>${schedCell}</td>
          <td><span style="font-size:12px;color:var(--muted2);">${esc(activeDaysLabel)}</span></td>
          <td>
            <span class="badge ${esc(statusCls)}"><span class="badge-dot"></span>${esc(statusLbl)}</span>
            <div style="font-size:11px;color:var(--muted2);margin-top:3px;">${d.last_run ? formatRelTime(d.last_run) : ''}</div>
          </td>
          <td>${activeBadge}</td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-trigger btn-sm" data-action="trigger" data-id="${Number(d.id)}" data-name="${esc(d.name)}">▶ Run</button>
              <button class="btn btn-ghost btn-sm"   data-action="edit"    data-id="${Number(d.id)}">Edit</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    setDriversPagination(data.total);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px;">${err.message}</td></tr>`;
  }
}

// ─── Confirm dialog (promise-based) ──────────────────────────────────────────
function showConfirm(message) {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').classList.add('open');

    function onOk()     { cleanup(); resolve(true);  }
    function onCancel() { cleanup(); resolve(false); }
    function cleanup() {
      document.getElementById('confirm-modal').classList.remove('open');
      document.getElementById('btn-confirm-ok').removeEventListener('click', onOk);
      document.getElementById('btn-confirm-cancel').removeEventListener('click', onCancel);
    }

    document.getElementById('btn-confirm-ok').addEventListener('click', onOk);
    document.getElementById('btn-confirm-cancel').addEventListener('click', onCancel);
  });
}

// ─── Trigger bot for a specific driver ───────────────────────────────────────
async function triggerDriver(id, name) {
  if (!await showConfirm(`Run bot now for ${esc(name)}?`)) return;
  try {
    await api(`/api/admin/drivers/${id}/trigger`, { method: 'POST' });
    showToast(`Bot triggered for ${name} — check logs for result`, 'info');
    setTimeout(loadLogs, 3000);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Admin per-day position modal ─────────────────────────────────────────────
let adminCurrentDayPositions = '{}';

const ADMIN_DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function renderAdminPosSummary(dayPositionsStr) {
  const el = document.getElementById('admin-pos-summary');
  if (!el) return;
  try {
    const dp = JSON.parse(dayPositionsStr || '{}');
    const parts = [];
    for (let d = 0; d < 7; d++) {
      const p = dp[String(d)];
      if (p) parts.push(`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]} ~${p}`);
    }
    el.textContent = parts.length ? parts.join(' · ') : 'No active days';
  } catch {
    el.textContent = '';
  }
}

function buildAdminDayPositionRows(dayPositions) {
  const container = document.getElementById('admin-pos-schedule-rows');
  container.innerHTML = '';

  for (let d = 0; d < 7; d++) {
    const key    = String(d);
    const pos    = dayPositions[key];
    const active = pos !== null && pos !== undefined;
    const row    = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);';
    if (d === 6) row.style.borderBottom = 'none';
    row.innerHTML = `
      <div class="day-sched-toggle ${active ? 'on' : ''}" data-day="${d}" style="flex-shrink:0;"></div>
      <span style="width:90px;font-size:14px;font-weight:600;">${ADMIN_DAY_NAMES[d]}</span>
      <input type="number" value="${pos || 200}" min="1" step="1" placeholder="e.g. 200"
             style="flex:1;padding:6px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--white);font-size:14px;"
             ${active ? '' : 'disabled'}>
    `;
    container.appendChild(row);

    row.querySelector('.day-sched-toggle').addEventListener('click', function () {
      this.classList.toggle('on');
      const input = row.querySelector('input[type="number"]');
      input.disabled = !this.classList.contains('on');
    });
  }
}

function readAdminDayPositionRows() {
  const dp = {};
  document.querySelectorAll('#admin-pos-schedule-rows > div').forEach((row, d) => {
    const toggle = row.querySelector('.day-sched-toggle');
    const input  = row.querySelector('input[type="number"]');
    dp[String(d)] = toggle.classList.contains('on') ? (parseInt(input.value, 10) || null) : null;
  });
  return JSON.stringify(dp);
}

document.getElementById('btn-open-admin-pos-sched').addEventListener('click', () => {
  let dp = {};
  try { dp = JSON.parse(adminCurrentDayPositions || '{}'); } catch {}
  buildAdminDayPositionRows(dp);
  document.getElementById('admin-pos-schedule-modal').classList.add('open');
});

document.getElementById('btn-admin-pos-sched-cancel').addEventListener('click', () => {
  document.getElementById('admin-pos-schedule-modal').classList.remove('open');
});

document.getElementById('btn-admin-pos-sched-confirm').addEventListener('click', () => {
  adminCurrentDayPositions = readAdminDayPositionRows();
  renderAdminPosSummary(adminCurrentDayPositions);
  document.getElementById('admin-pos-schedule-modal').classList.remove('open');
});

// ─── Schedule mode toggle ─────────────────────────────────────────────────────
function setAdminSchedMode(mode) {
  const isTime = mode === 'time';
  document.getElementById('m-sched-time-block').style.display = isTime ? '' : 'none';
  document.getElementById('m-sched-pos-block').style.display  = isTime ? 'none' : '';
  document.getElementById('m-sched-type-time').className = isTime ? 'btn btn-primary' : 'btn btn-ghost';
  document.getElementById('m-sched-type-pos').className  = isTime ? 'btn btn-ghost'   : 'btn btn-primary';
}

document.getElementById('m-sched-type-time').addEventListener('click', () => setAdminSchedMode('time'));
document.getElementById('m-sched-type-pos').addEventListener('click',  () => setAdminSchedMode('position'));

// ─── Add driver modal (blank form) ────────────────────────────────────────────
function openAddDriverModal() {
  document.getElementById('modal-title').textContent = 'Add Driver';
  document.getElementById('modal-driver-id').value  = '';
  ['m-name', 'm-phone', 'm-email', 'm-san-user', 'm-san-pass', 'm-vehicle', 'm-notes', 'm-app-pass'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('m-time').value   = '05:00';
  document.getElementById('m-active').value = '1';
  setAdminSchedMode('time');
  adminCurrentDayPositions = '{}';
  renderAdminPosSummary(adminCurrentDayPositions);

  // Default: all 7 days active at 05:00
  const defaultDs = {};
  for (let d = 0; d < 7; d++) defaultDs[String(d)] = '05:00';
  adminCurrentDaySchedules = JSON.stringify(defaultDs);
  renderAdminSchedSummary(adminCurrentDaySchedules);

  document.getElementById('modal-error').textContent = '';
  document.getElementById('driver-modal').classList.add('open');
}

// ─── Edit driver modal (pre-populated) ───────────────────────────────────────
async function openEditModal(id) {
  try {
    const d = await api(`/api/admin/drivers/${id}`);
    if (!d) return; // 401 already handled

    document.getElementById('modal-title').textContent    = 'Edit Driver';
    document.getElementById('modal-driver-id').value      = id;
    document.getElementById('m-name').value               = d.name          || '';
    document.getElementById('m-phone').value              = d.phone         || '';
    document.getElementById('m-email').value              = d.email         || '';
    document.getElementById('m-san-user').value           = d.san_username  || '';
    document.getElementById('m-san-pass').value           = '';
    document.getElementById('m-app-pass').value           = '';
    document.getElementById('m-vehicle').value            = d.vehicle_number || '';
    document.getElementById('m-active').value             = d.is_active ? '1' : '0';
    document.getElementById('m-notes').value              = d.notes         || '';

    if (d.day_positions || d.scheduled_position) {
      setAdminSchedMode('position');
      if (d.day_positions) {
        adminCurrentDayPositions = d.day_positions;
      } else {
        // Migrate legacy single-position to per-day (all days same position)
        const dp = {};
        for (let day = 0; day < 7; day++) dp[String(day)] = d.scheduled_position;
        adminCurrentDayPositions = JSON.stringify(dp);
      }
      renderAdminPosSummary(adminCurrentDayPositions);
    } else {
      setAdminSchedMode('time');
      document.getElementById('m-time').value = d.scheduled_time || '05:00';
      adminCurrentDayPositions = '{}';
      // Load day_schedules or convert from legacy scheduled_days + scheduled_time
      if (d.day_schedules) {
        adminCurrentDaySchedules = d.day_schedules;
      } else {
        const activeDays = (d.scheduled_days || '0,1,2,3,4,5,6').split(',').map(String);
        const ds = {};
        for (let day = 0; day < 7; day++) {
          ds[String(day)] = activeDays.includes(String(day)) ? (d.scheduled_time || '05:00') : null;
        }
        adminCurrentDaySchedules = JSON.stringify(ds);
      }
      renderAdminSchedSummary(adminCurrentDaySchedules);
    }

    document.getElementById('modal-error').textContent = '';
    document.getElementById('driver-modal').classList.add('open');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Close the add/edit modal ────────────────────────────────────────────────
function closeModal() {
  document.getElementById('driver-modal').classList.remove('open');
}

// ─── Temp-password reveal overlay (shown after driver creation) ───────────────
function showTempPasswordAlert(driverName, tempPassword) {
  const overlay = document.createElement('div');
  overlay.id = 'temp-pw-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface);border-radius:12px;padding:32px 28px;max-width:420px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.4);text-align:center;';
  box.innerHTML = `
    <div style="font-size:36px;margin-bottom:12px;">🔑</div>
    <h3 style="margin:0 0 8px;font-size:18px;">Driver Created</h3>
    <p style="color:var(--muted2);font-size:13px;margin:0 0 20px;">
      Share this one-time password with <strong>${esc(driverName)}</strong>.<br>
      It is not stored and cannot be recovered.
    </p>
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
      <code id="tmp-pw-text" style="font-size:20px;letter-spacing:2px;color:var(--fg);font-family:monospace;">${tempPassword}</code>
      <button id="tmp-pw-copy" style="flex-shrink:0;padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--fg);cursor:pointer;font-size:13px;">Copy</button>
    </div>
    <button id="tmp-pw-done" class="btn btn-primary" style="width:100%;">Done — I've noted it</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('tmp-pw-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(tempPassword).then(() => {
      document.getElementById('tmp-pw-copy').textContent = '✓ Copied';
    });
  });

  const close = () => overlay.remove();
  document.getElementById('tmp-pw-done').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Pagination
document.getElementById('drivers-prev').addEventListener('click', () => {
  if (driversPage > 1) loadDrivers(driversPage - 1);
});
document.getElementById('drivers-next').addEventListener('click', () => {
  loadDrivers(driversPage + 1);
});

// Debounced driver search
let searchTimeout;
document.getElementById('driver-search').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadDrivers(1), 300);
});

// Static buttons
document.getElementById('btn-add-driver').addEventListener('click', openAddDriverModal);
document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);

// Event delegation for dynamically-generated driver table rows
document.getElementById('drivers-table-body').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === 'edit')    openEditModal(id);
  if (btn.dataset.action === 'trigger') triggerDriver(id, btn.dataset.name);
});

// Save driver (create or update)
document.getElementById('btn-save-driver').addEventListener('click', async () => {
  const id     = document.getElementById('modal-driver-id').value;
  const isEdit = !!id;
  const errEl  = document.getElementById('modal-error');
  errEl.textContent = '';

  const posMode = document.getElementById('m-sched-type-pos').classList.contains('btn-primary');

  const body = {
    name:          document.getElementById('m-name').value.trim(),
    phone:         document.getElementById('m-phone').value.trim(),
    email:         document.getElementById('m-email').value.trim(),
    sanUsername:   document.getElementById('m-san-user').value.trim(),
    vehicleNumber: document.getElementById('m-vehicle').value.trim(),
    isActive:      document.getElementById('m-active').value === '1',
    notes:         document.getElementById('m-notes').value.trim(),
  };

  if (posMode) {
    const dp = JSON.parse(adminCurrentDayPositions || '{}');
    const hasActive = Object.values(dp).some(v => v !== null);
    if (!hasActive) {
      errEl.textContent = 'Configure at least one active day in the position schedule';
      return;
    }
    body.dayPositions = adminCurrentDayPositions;
  } else {
    body.scheduledTime = document.getElementById('m-time').value;
    body.daySchedules  = adminCurrentDaySchedules;
    // Derive scheduledDays for legacy compatibility
    if (adminCurrentDaySchedules) {
      try {
        const ds         = JSON.parse(adminCurrentDaySchedules);
        const activeDays = Object.keys(ds).filter(k => ds[k] !== null);
        const times      = activeDays.map(k => ds[k]).filter(Boolean);
        body.scheduledTime = times[0] || body.scheduledTime || '05:00';
        body.scheduledDays = activeDays.join(',') || '0,1,2,3,4,5,6';
      } catch {}
    }
  }

  const sanPass = document.getElementById('m-san-pass').value;
  if (sanPass) body.sanPassword = sanPass;

  const appPass = document.getElementById('m-app-pass').value;
  if (appPass) body.appPassword = appPass;

  const btn = document.getElementById('btn-save-driver');
  btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;

  try {
    if (isEdit) {
      await api(`/api/admin/drivers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Driver updated ✓');
    } else {
      if (!body.sanUsername || !sanPass || !body.vehicleNumber || !body.name) {
        throw new Error('Name, SAN username, password, and vehicle number are required');
      }
      body.sanPassword  = sanPass;
      const created     = await api('/api/admin/drivers', { method: 'POST', body: JSON.stringify(body) });
      if (!created) return; // 401 handled
      closeModal();
      loadDrivers();
      // Show temp password in a dismissable overlay so admin can copy it
      showTempPasswordAlert(created.name, created.tempPassword);
      return; // skip the generic closeModal() below
    }
    closeModal();
    loadDrivers();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Save Driver'; btn.disabled = false;
  }
});

// Close modal when clicking the overlay backdrop
document.getElementById('driver-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('driver-modal')) closeModal();
});
