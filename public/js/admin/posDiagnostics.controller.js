// ─── Early Join Alerts Controller ─────────────────────────────────────────────
// Loads and renders the position-scheduler diagnostic page.
//
// Two sections:
//   1. Live — current in-memory state for every position-scheduled driver.
//      Drivers with an early-join warning are highlighted and can be re-armed.
//   2. History — DB records of skip_already_seen events from the last 14 days,
//      so patterns (e.g. certain drivers always joining early) are visible.

let _diagRefreshTimer = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATE_LABELS = {
  watching:    { label: 'Watching',    color: 'var(--muted2)' },
  in_queue:    { label: 'In Queue',    color: 'var(--green)'  },
  dispatched:  { label: 'Dispatched',  color: 'var(--amber)'  },
  at_terminal: { label: 'At Terminal', color: 'var(--blue)'   },
  requeuing:   { label: 'Re-queuing',  color: 'var(--purple)' },
  gone:        { label: 'Gone',        color: 'var(--red)'    },
};

const SCHED_LABELS = {
  waiting:           { label: '⏳ Waiting',              color: 'var(--muted2)',  bg: 'rgba(90,101,133,0.15)'      },
  rearmed_waiting:   { label: '🔄 Re-armed — holding',  color: 'var(--amber)',   bg: 'rgba(245,166,35,0.15)'      },
  armed_early_join:  { label: '⚡ Re-armed — live',     color: 'var(--teal)',    bg: 'rgba(0,209,178,0.10)'       },
  blocked:           { label: '🚫 Blocked',              color: 'var(--red)',     bg: 'rgba(240,90,91,0.12)'       },
  fired:             { label: '✅ Fired',                color: 'var(--green)',   bg: 'rgba(39,192,131,0.12)'      },
  off_day:           { label: '—  Off Day',              color: 'var(--muted)',   bg: 'rgba(90,101,133,0.10)'      },
  awaiting_carryover:{ label: '⏸ Carryover',            color: 'var(--purple)',  bg: 'rgba(167,139,250,0.12)'     },
};

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtDate(str) {
  if (!str) return '—';
  // str is YYYY-MM-DD
  const [y, m, d] = str.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

function rowBg(warningLevel) {
  if (warningLevel === 'critical') return 'rgba(240,90,91,0.05)';
  if (warningLevel === 'warning')  return 'rgba(245,166,35,0.04)';
  return '';
}

// ─── Re-arm button handler ───────────────────────────────────────────────────

async function rearmDriver(driverId, vehicleNumber) {
  try {
    const data = await api(`/api/admin/drivers/${driverId}/rearm-position`, { method: 'POST' });
    if (!data) return;
    showToast(`#${vehicleNumber} scheduler re-armed`, 'success');
    await loadPosDiagnostics();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Live table renderer ─────────────────────────────────────────────────────

function renderLiveRow(r) {
  const stateInfo  = STATE_LABELS[r.currentState]  || { label: r.currentState || '—', color: 'var(--muted2)' };
  const schedInfo  = SCHED_LABELS[r.schedulerStatus] || { label: r.schedulerStatus, color: 'var(--muted2)', bg: '' };

  const livePos    = r.currentPosition != null ? `#${r.currentPosition}` : '—';
  const earlyAt    = r.earlyJoinDetectedAt ? fmtTime(r.earlyJoinDetectedAt) : '—';
  const earlyPos   = r.earlyJoinAtPosition != null ? `#${r.earlyJoinAtPosition}` : '—';

  let gapCell = '—';
  if (r.earlyJoinGap != null) {
    const gapColor = r.earlyJoinGap > 60 ? 'var(--red)' : r.earlyJoinGap > 20 ? 'var(--amber)' : 'var(--green)';
    gapCell = `<span style="font-weight:700;color:${gapColor};">+${r.earlyJoinGap}</span>`;
  }

  // Re-arm button: auto-rearm happens in the scheduler loop, so this manual
  // button is only useful when blocked (driver returned past max and the
  // scheduler locked out). For warning states the system already self-corrects.
  const rearmBtn = r.warningLevel === 'critical'
    ? `<button class="btn btn-sm btn-trigger" onclick="rearmDriver(${r.driverId},'${esc(r.vehicleNumber)}')" title="Force re-arm: clears all early-join flags and lets the position scheduler try again">🔄 Force Re-arm</button>`
    : '<span style="color:var(--muted);font-size:12px;">—</span>';

  return `
    <tr style="background:${rowBg(r.warningLevel)};">
      <td><span class="mono" style="font-weight:700;">${esc(r.vehicleNumber)}</span></td>
      <td style="font-weight:500;">${esc(r.driverName)}</td>
      <td style="color:var(--teal);font-weight:700;">${r.todayTarget ?? '—'}</td>
      <td style="color:var(--muted2);">${r.maxAcceptable ?? '—'}</td>
      <td><span style="color:${stateInfo.color};font-weight:600;">${stateInfo.label}</span></td>
      <td class="mono" style="color:var(--white);">${livePos}</td>
      <td style="color:var(--muted2);font-size:12px;">${earlyAt}</td>
      <td class="mono" style="color:${r.earlyJoinAtPosition != null ? 'var(--amber)' : 'var(--muted2)'};">${earlyPos}</td>
      <td>${gapCell}</td>
      <td>
        <span style="
          display:inline-flex;align-items:center;gap:5px;
          padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;
          color:${schedInfo.color};background:${schedInfo.bg};
        ">${schedInfo.label}</span>
      </td>
      <td style="text-align:center;">${rearmBtn}</td>
    </tr>`;
}

// ─── Borrowed-driver rescue handler ──────────────────────────────────────────

async function rescueBorrowed(driverId, vehicleNumber) {
  if (!confirm(`Rescue #${vehicleNumber}? This force-removes them from SAN's queue, stops borrowing them today, and re-arms them for their real target.`)) return;
  try {
    const data = await api(`/api/admin/drivers/${driverId}/rescue-borrow`, { method: 'POST' });
    if (!data) return;
    showToast(`#${vehicleNumber} rescued & re-armed`, 'success');
    await loadPosDiagnostics();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Borrowed probe drivers table renderer ───────────────────────────────────

function renderBorrowedRow(r) {
  // Borrow status pill
  let statusPill;
  if (r.borrowedNow) {
    statusPill = { label: '🔄 Borrowed now', color: 'var(--amber)', bg: 'rgba(245,166,35,0.15)' };
  } else if (r.borrowRetiredAt) {
    statusPill = { label: '↩︎ Retired & re-armed', color: 'var(--teal)', bg: 'rgba(0,209,178,0.10)' };
  } else {
    statusPill = { label: '⏳ Pending', color: 'var(--muted2)', bg: 'rgba(90,101,133,0.15)' };
  }
  if (r.borrowExcluded) statusPill = { label: '🛟 Rescued', color: 'var(--purple)', bg: 'rgba(167,139,250,0.12)' };

  const fireCell = r.positionFiredToday
    ? '<span style="color:var(--green);font-weight:600;">✅ Fired</span>'
    : '<span style="color:var(--muted2);">— not yet</span>';

  const landed = r.landedPosition != null ? `#${r.landedPosition}` : '—';

  let onTarget;
  if (r.landedOnTarget === true)  onTarget = '<span style="color:var(--green);font-weight:700;">✓ on target</span>';
  else if (r.landedOnTarget === false) {
    const delta = (r.landedPosition != null && r.todayTarget != null) ? (r.landedPosition - r.todayTarget) : null;
    onTarget = `<span style="color:var(--red);font-weight:700;">✗ ${delta > 0 ? '+' : ''}${delta ?? '?'}</span>`;
  } else onTarget = '<span style="color:var(--muted2);">—</span>';

  // Rescue button only useful while still borrowed / not yet safely fired
  const rescueBtn = (r.borrowedNow || (!r.positionFiredToday && r.borrowCycles > 0))
    ? `<button class="btn btn-sm btn-trigger" onclick="rescueBorrowed(${r.driverId},'${esc(r.vehicleNumber)}')" title="Force-remove from SAN, stop borrowing today, re-arm for real target">🛟 Rescue</button>`
    : '<span style="color:var(--muted);font-size:12px;">—</span>';

  return `
    <tr>
      <td><span class="mono" style="font-weight:700;">${esc(r.vehicleNumber)}</span></td>
      <td style="font-weight:500;">${esc(r.driverName)}</td>
      <td style="color:var(--teal);font-weight:700;">${r.todayTarget ?? '—'}</td>
      <td class="mono" style="color:var(--white);">${r.borrowCycles}×</td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;color:${statusPill.color};background:${statusPill.bg};">${statusPill.label}</span></td>
      <td>${fireCell}</td>
      <td class="mono" style="color:var(--white);">${landed}</td>
      <td>${onTarget}</td>
      <td style="text-align:center;">${rescueBtn}</td>
    </tr>`;
}

// ─── History table renderer ──────────────────────────────────────────────────

function renderHistoryRow(r) {
  const dateLabel  = fmtDate(r.tracking_date);
  const queueSize  = r.queue_size_at_fire != null ? r.queue_size_at_fire : '—';
  const earlyPos   = r.early_join_position != null
    ? `<span class="mono" style="color:var(--amber);font-weight:700;">#${r.early_join_position}</span>`
    : '<span style="color:var(--muted2);">—</span>';

  let gapCell = '—';
  if (r.early_join_position != null && r.target_position != null) {
    const gap = r.target_position - r.early_join_position;
    if (gap > 0) {
      const col = gap > 60 ? 'var(--red)' : gap > 20 ? 'var(--amber)' : 'var(--green)';
      gapCell = `<span style="font-weight:700;color:${col};">+${gap}</span>`;
    } else {
      gapCell = `<span style="color:var(--muted2);">${gap}</span>`;
    }
  }

  // Human-readable reason
  const REASON_MAP = {
    driver_already_in_queue_today: 'Already in queue',
  };
  const reason = REASON_MAP[r.decision_reason] || r.decision_reason || '—';

  return `
    <tr>
      <td style="color:var(--muted2);font-size:12px;white-space:nowrap;">${dateLabel}</td>
      <td style="font-weight:500;">${esc(r.driver_name)}</td>
      <td><span class="mono">${esc(r.vehicle_number)}</span></td>
      <td style="color:var(--teal);font-weight:700;">${r.target_position ?? '—'}</td>
      <td style="color:var(--muted2);">${r.max_acceptable_position ?? '—'}</td>
      <td style="color:var(--muted2);">${queueSize}</td>
      <td>${earlyPos}</td>
      <td>${gapCell}</td>
      <td style="font-size:12px;color:var(--muted2);">${reason}</td>
    </tr>`;
}

// ─── Main load function ──────────────────────────────────────────────────────

async function loadPosDiagnostics() {
  const liveTbody    = document.getElementById('diag-live-tbody');
  const histTbody    = document.getElementById('diag-history-tbody');
  const refreshLabel = document.getElementById('diag-last-refresh');

  try {
    const data = await api('/api/admin/position-diagnostics');
    if (!data) return;

    const { live = [], history = [] } = data;

    // ── Stats bar ──────────────────────────────────────────────────────────
    const total   = live.length;
    const armed   = live.filter(r => r.warningLevel === 'warning').length;
    const blocked = live.filter(r => r.warningLevel === 'critical').length;
    const ok      = total - armed - blocked;

    document.getElementById('diag-stat-total').textContent   = total;
    document.getElementById('diag-stat-armed').textContent   = armed;
    document.getElementById('diag-stat-blocked').textContent = blocked;
    document.getElementById('diag-stat-ok').textContent      = ok;

    // Update the nav badge
    const badge = document.getElementById('early-join-badge');
    if (badge) {
      const alertCount = armed + blocked;
      if (alertCount > 0) {
        badge.textContent   = alertCount;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    // ── Live table ─────────────────────────────────────────────────────────
    if (!live.length) {
      liveTbody.innerHTML = `
        <tr><td colspan="11">
          <div class="empty-state">
            <div class="icon">📍</div>
            <div>No position-scheduled drivers active today</div>
          </div>
        </td></tr>`;
    } else {
      liveTbody.innerHTML = live.map(renderLiveRow).join('');
    }

    // ── Borrowed probe drivers table (only shown when any exist today) ──────
    const borrowedWrap  = document.getElementById('diag-borrowed-wrap');
    const borrowedTbody = document.getElementById('diag-borrowed-tbody');
    const borrowed      = live.filter(r => r.borrowCycles > 0 || r.borrowedNow);
    if (borrowedWrap && borrowedTbody) {
      if (borrowed.length) {
        borrowedWrap.style.display = '';
        borrowedTbody.innerHTML = borrowed
          .sort((a, b) => (b.todayTarget ?? 0) - (a.todayTarget ?? 0))
          .map(renderBorrowedRow).join('');
      } else {
        borrowedWrap.style.display = 'none';
      }
    }

    // ── History table ──────────────────────────────────────────────────────
    if (!history.length) {
      histTbody.innerHTML = `
        <tr><td colspan="9">
          <div class="empty-state">
            <div class="icon">✅</div>
            <div>No early-join events in the last 14 days</div>
          </div>
        </td></tr>`;
    } else {
      histTbody.innerHTML = history.map(renderHistoryRow).join('');
    }

    // ── Timestamp ─────────────────────────────────────────────────────────
    if (refreshLabel) {
      refreshLabel.textContent = `Last refresh: ${new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      })} PT`;
    }

  } catch (err) {
    liveTbody.innerHTML = `<tr><td colspan="11" style="color:var(--red);text-align:center;padding:24px;">${err.message}</td></tr>`;
    histTbody.innerHTML = `<tr><td colspan="9"  style="color:var(--red);text-align:center;padding:24px;">${err.message}</td></tr>`;
  }
}

// ─── Auto-refresh while page is visible ─────────────────────────────────────

function startDiagRefresh() {
  stopDiagRefresh();
  _diagRefreshTimer = setInterval(() => {
    if (document.getElementById('page-pos-diagnostics')?.classList.contains('active')) {
      loadPosDiagnostics();
    }
  }, 30000);
}

function stopDiagRefresh() {
  if (_diagRefreshTimer) { clearInterval(_diagRefreshTimer); _diagRefreshTimer = null; }
}

// ─── Button wiring ───────────────────────────────────────────────────────────

document.getElementById('btn-refresh-diagnostics')?.addEventListener('click', () => {
  loadPosDiagnostics();
});

// Start the refresh loop once (it self-gates on page visibility)
startDiagRefresh();
