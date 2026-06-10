// ─── Driver SOS Controller ───────────────────────────────────────────────────
// Hold-to-confirm SOS button. When the driver holds for 2 s:
//   1. Fire alert IMMEDIATELY (no waiting on geolocation — coords might be null)
//   2. In parallel, ask the browser for a one-shot GPS fix; patch the alert
//      with coords as soon as they arrive
//   3. UI swaps to the "Active" panel. Driver can toggle live tracking, which
//      starts a watchPosition stream of updates, or cancel the alert.
//
// Reliability features:
//   • Retry queue: failed create POSTs are stashed in localStorage and retried
//     on the 'online' event + every 5 s while still failing.
//   • Re-attach on boot: GET /api/driver/sos/open lets the dashboard re-discover
//     an active alert after a tab reload mid-emergency.
//   • Background sync: if the SW supports it, we register a sync tag so a
//     pending alert eventually goes out even if the tab is closed.
//
// Depends on: utils.js (api, showToast)

const SOS_HOLD_MS = 2000;
const SOS_LIVE_INTERVAL_MS = 12000;
const SOS_STATUS_POLL_MS   = 8000; // how often to ask "is the alert still open?"
const SOS_RETRY_KEY = 'sos:pending';

let sosState = {
  alertId:        null,
  liveTracking:   false,
  watchId:        null,
  liveTimer:      null,
  statusPoll:     null,
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function $sos(id) { return document.getElementById(id); }

function setSosIdle() {
  $sos('btn-sos').style.display          = 'flex';
  $sos('sos-active-panel').style.display = 'none';
  $sos('btn-sos-progress').style.width   = '0%';
  $sos('btn-sos-sub').textContent        = 'Press and hold for 2 seconds to alert admin';
  stopLiveTracking();
  stopStatusPolling();
  hideLocationHelp();
  sosState.alertId      = null;
  sosState.liveTracking = false;
}

function setSosActive(alert) {
  sosState.alertId      = alert.id;
  sosState.liveTracking = Boolean(alert.live_tracking);

  $sos('btn-sos').style.display          = 'none';
  $sos('sos-active-panel').style.display = 'block';
  $sos('sos-live-toggle').checked        = sosState.liveTracking;

  const statusEl = $sos('sos-active-status');
  if (alert.status === 'acknowledged') {
    statusEl.textContent = 'Acknowledged';
    statusEl.style.color = '#fbbf24';
    $sos('sos-active-detail').textContent = 'An admin is handling your alert.';
  } else {
    statusEl.textContent = 'Sent';
    statusEl.style.color = '#fca5a5';
  }

  const initialAcc = alert.latest_accuracy != null ? Number(alert.latest_accuracy) : null;
  if (alert.latest_lat != null) {
    $sos('sos-location-status').textContent =
      `📍 Location shared (±${Math.round(initialAcc || 0)} m)`;
  } else {
    $sos('sos-location-status').textContent = '📍 Locating you…';
  }

  if (sosState.liveTracking) startLiveTracking();
  startStatusPolling();
}

// ─── Status polling ───────────────────────────────────────────────────────────
// The admin can resolve the alert from their panel. The driver tab has no SSE,
// so we lightly poll `/api/driver/sos/open` to detect the close — and re-check
// immediately whenever the tab becomes visible again.
function startStatusPolling() {
  stopStatusPolling();
  sosState.statusPoll = setInterval(checkSosStatus, SOS_STATUS_POLL_MS);
  document.addEventListener('visibilitychange', onVisibilityForSos);
  window.addEventListener('focus', checkSosStatus);
}

function stopStatusPolling() {
  if (sosState.statusPoll) { clearInterval(sosState.statusPoll); sosState.statusPoll = null; }
  document.removeEventListener('visibilitychange', onVisibilityForSos);
  window.removeEventListener('focus', checkSosStatus);
}

function onVisibilityForSos() {
  if (document.visibilityState === 'visible') checkSosStatus();
}

async function checkSosStatus() {
  if (!sosState.alertId) return;
  let resp;
  try {
    resp = await api('/api/driver/sos/open');
  } catch {
    return; // network blip — try again next tick
  }

  if (!resp.alert) {
    // No open alert server-side → admin resolved (or it was cancelled elsewhere)
    showToast('✅ Admin resolved your SOS alert', 'success', 5000);
    setSosIdle();
    return;
  }

  // Surface acknowledgement state if it just flipped
  if (resp.alert.id === sosState.alertId && resp.alert.status === 'acknowledged') {
    const statusEl = $sos('sos-active-status');
    if (statusEl && statusEl.textContent !== 'Acknowledged') {
      statusEl.textContent = 'Acknowledged';
      statusEl.style.color = '#fbbf24';
      $sos('sos-active-detail').textContent = 'An admin is handling your alert.';
    }
  }
}

// ─── Geolocation ──────────────────────────────────────────────────────────────
// Returns { coords } on success, { error: PositionError } on failure, or null
// if the browser has no geolocation support. Caller decides how to display.
function getOneShotLocation(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ coords: {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
      }}),
      (err) => resolve({ error: err }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

function showLocationDeniedHelp(err) {
  const help = $sos('sos-location-help');
  if (help) help.style.display = 'block';
  // PERMISSION_DENIED (1) — site is permanently blocked. POSITION_UNAVAILABLE (2),
  // TIMEOUT (3) — transient, retry usually works.
  const status = $sos('sos-location-status');
  if (status) {
    status.textContent = err?.code === 1
      ? '📍 Location access denied'
      : '📍 Location unavailable — please try again';
  }
}

function hideLocationHelp() {
  const help = $sos('sos-location-help');
  if (help) help.style.display = 'none';
}

function startLiveTracking() {
  stopLiveTracking();
  if (!('geolocation' in navigator)) return;

  let lastPushAt = 0;
  sosState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - lastPushAt < SOS_LIVE_INTERVAL_MS) return;
      lastPushAt = now;
      const body = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      api(`/api/driver/sos/${sosState.alertId}/location`, {
        method: 'POST', body: JSON.stringify(body),
      }).then(() => {
        $sos('sos-location-status').textContent =
          `📍 Live (updated ${new Date().toLocaleTimeString()}, ±${Math.round(body.accuracy)} m)`;
      }).catch(() => { /* swallow — next tick retries */ });
    },
    (err) => {
      showLocationDeniedHelp(err);
      // Permission denied — stop watching, untick the toggle, persist the
      // change so the next fix attempt doesn't loop with another rejection.
      if (err.code === 1) {
        stopLiveTracking();
        const toggle = $sos('sos-live-toggle');
        if (toggle) toggle.checked = false;
        sosState.liveTracking = false;
        if (sosState.alertId) {
          api(`/api/driver/sos/${sosState.alertId}/live-tracking`, {
            method: 'POST', body: JSON.stringify({ enabled: false }),
          }).catch(() => {});
        }
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

function stopLiveTracking() {
  if (sosState.watchId != null) {
    navigator.geolocation.clearWatch(sosState.watchId);
    sosState.watchId = null;
  }
}

// ─── Retry queue for offline / network-failure cases ──────────────────────────
function enqueuePendingAlert(body) {
  try {
    const queue = JSON.parse(localStorage.getItem(SOS_RETRY_KEY) || '[]');
    queue.push({ body, queuedAt: Date.now() });
    localStorage.setItem(SOS_RETRY_KEY, JSON.stringify(queue));
  } catch { /* localStorage full or disabled — give up gracefully */ }
}

async function flushPendingAlerts() {
  let queue;
  try { queue = JSON.parse(localStorage.getItem(SOS_RETRY_KEY) || '[]'); }
  catch { return; }
  if (!queue.length) return;

  for (const item of queue.slice()) {
    try {
      const { alert } = await api('/api/driver/sos', {
        method: 'POST', body: JSON.stringify(item.body),
      });
      queue.shift();
      localStorage.setItem(SOS_RETRY_KEY, JSON.stringify(queue));
      if (alert && !sosState.alertId) {
        setSosActive(alert);
        showToast('🚨 Queued SOS sent — admin notified', 'success', 4000);
      }
    } catch {
      break; // still offline / failing — wait for next trigger
    }
  }
}

// ─── Fire the alert ───────────────────────────────────────────────────────────
async function fireSos() {
  // Immediate UI feedback
  $sos('btn-sos-sub').textContent = 'Sending alert…';

  // Don't await location — fire alert immediately so help is on the way even
  // if GPS lock takes 20 s.
  const body = { liveTracking: false };

  let alert;
  try {
    const resp = await api('/api/driver/sos', {
      method: 'POST', body: JSON.stringify(body),
    });
    alert = resp.alert;
  } catch (err) {
    // Queue locally and retry. Try Background Sync if available.
    enqueuePendingAlert(body);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sos-flush').catch(() => {});
      } catch { /* ignore */ }
    }
    showToast('Network issue — alert queued and will retry automatically', 'error', 6000);
    $sos('btn-sos-sub').textContent = 'Queued — retrying…';
    return;
  }

  setSosActive(alert);
  if (typeof navigator.vibrate === 'function') navigator.vibrate([100, 60, 100]);
  showToast('🚨 SOS sent — admin notified', 'success', 5000);

  await captureAndShareLocation();
}

// Tries one geolocation fix and pushes it to the active alert. Reused by the
// initial fire AND the "Try again" button on the denied-help banner.
async function captureAndShareLocation() {
  if (!sosState.alertId) return;
  const result = await getOneShotLocation();

  if (result?.coords) {
    hideLocationHelp();
    try {
      await api(`/api/driver/sos/${sosState.alertId}/location`, {
        method: 'POST', body: JSON.stringify(result.coords),
      });
      $sos('sos-location-status').textContent =
        `📍 Location shared (±${Math.round(result.coords.accuracy)} m)`;
    } catch { /* swallow — next live update or retry will catch it */ }
    return;
  }

  // No support, no result, or denied. Show helpful UI.
  showLocationDeniedHelp(result?.error);
}

// ─── Cancel ───────────────────────────────────────────────────────────────────
async function cancelSos() {
  if (!sosState.alertId) return;
  const id = sosState.alertId;

  $sos('btn-sos-cancel').disabled = true;
  $sos('btn-sos-cancel').textContent = 'Cancelling…';

  try {
    await api(`/api/driver/sos/${id}/cancel`, { method: 'POST' });
    showToast('SOS alert cancelled', 'success', 3000);
  } catch (err) {
    // Most common 409: admin just resolved it on their side. Treat as "already
    // done" and snap to idle instead of showing a scary error.
    if (err.status === 409) {
      showToast('✅ Admin already resolved your SOS alert', 'success', 4000);
    } else {
      showToast(err.message || 'Could not cancel alert', 'error');
      $sos('btn-sos-cancel').disabled = false;
      $sos('btn-sos-cancel').textContent = 'Cancel SOS Alert';
      return;
    }
  }

  $sos('btn-sos-cancel').disabled = false;
  $sos('btn-sos-cancel').textContent = 'Cancel SOS Alert';
  setSosIdle();
}

// ─── Boot: re-attach to any in-flight alert ───────────────────────────────────
async function bootSos() {
  try {
    const { alert } = await api('/api/driver/sos/open');
    if (alert) setSosActive(alert);
    else setSosIdle();
  } catch {
    setSosIdle();
  }
  // Flush any queued offline alerts
  flushPendingAlerts();
}

// ─── Hold-to-confirm wiring ───────────────────────────────────────────────────
(function wireSosButton() {
  const btn = $sos('btn-sos');
  if (!btn) return; // defensive — script may load on login screen

  let holdTimer = null;
  let progressTimer = null;
  let holding = false;

  function startHold() {
    if (holding || sosState.alertId) return;
    holding = true;
    $sos('btn-sos-sub').textContent = 'Keep holding to send…';

    const startedAt = Date.now();
    progressTimer = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startedAt) / SOS_HOLD_MS) * 100);
      $sos('btn-sos-progress').style.width = `${pct}%`;
    }, 80);

    holdTimer = setTimeout(() => {
      clearInterval(progressTimer); progressTimer = null;
      $sos('btn-sos-progress').style.width = '100%';
      if (typeof navigator.vibrate === 'function') navigator.vibrate(80);
      fireSos();
      holding = false;
    }, SOS_HOLD_MS);
  }

  function cancelHold() {
    if (!holding) return;
    holding = false;
    clearTimeout(holdTimer);   holdTimer = null;
    clearInterval(progressTimer); progressTimer = null;
    $sos('btn-sos-progress').style.width = '0%';
    if (!sosState.alertId) $sos('btn-sos-sub').textContent = 'Press and hold for 2 seconds to alert admin';
  }

  // Pointer events cover mouse + touch + pen without double-firing
  btn.addEventListener('pointerdown', startHold);
  btn.addEventListener('pointerup',     cancelHold);
  btn.addEventListener('pointerleave',  cancelHold);
  btn.addEventListener('pointercancel', cancelHold);

  $sos('btn-sos-cancel').addEventListener('click', cancelSos);

  $sos('btn-sos-retry-location')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Requesting location…';
    await captureAndShareLocation();
    btn.disabled = false; btn.textContent = 'Try sharing location again';
  });

  $sos('sos-live-toggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (!sosState.alertId) return;
    try {
      await api(`/api/driver/sos/${sosState.alertId}/live-tracking`, {
        method: 'POST', body: JSON.stringify({ enabled }),
      });
      sosState.liveTracking = enabled;
      if (enabled) startLiveTracking();
      else stopLiveTracking();
    } catch (err) {
      e.target.checked = !enabled;
      showToast(err.message || 'Could not toggle live tracking', 'error');
    }
  });

  // Retry queued alerts when we come back online
  window.addEventListener('online', flushPendingAlerts);

  // Background Sync from the SW fires this message when network returns
  // and the tab is closed/backgrounded. SW can't make authenticated requests
  // (no cookies in fetch from SW context here) so it delegates back to a tab.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'sos-flush') flushPendingAlerts();
    });
  }
})();

// Expose for app.js to call after login
window.bootSos = bootSos;
