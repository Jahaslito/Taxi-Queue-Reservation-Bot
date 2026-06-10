// ─── Admin SOS Controller ─────────────────────────────────────────────────────
// SSE-driven live feed of driver SOS alerts.
//   • Connects on admin login and stays connected (alerts must surface on ANY page).
//   • New alert (sos.new) → looping audible + global banner + sidebar badge bump.
//   • Acknowledge / resolve via REST endpoints; the server emits sos.updated
//     which re-renders the affected card.
//   • Map: tap "Open in Google Maps" → opens https://www.google.com/maps?q=lat,lng
//     in a new tab. Avoids loading map tiles (CSP-friendly, no extra deps).
//   • Web Push: optional "Enable Push" button uses VAPID + the existing SW to
//     receive notifications when no admin tab is open.
//
// Depends on: utils.js (api, esc, showToast)

let sosSSE         = null;
let sosAlertsById  = new Map();     // id → enriched alert row (for re-render)
let sosOpenCount   = 0;
let audioUnlocked  = false;         // browsers block .play() until a user gesture

// ─── Audio: synthesized beep via Web Audio API ────────────────────────────────
// Embedded WAV data URLs proved unreliable (some browsers refuse to autoplay,
// volume is uncontrollable, encoded payload silently fails). Generating an
// oscillator tone gives us a loud, predictable, on-demand "beep beep beep".
let audioCtx       = null;
let beepTimer      = null;    // setInterval ID — drives the recurring beep
let beepingActive  = false;

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
}

/** One short, loud beep (two-tone — high then low — for emergency cadence). */
function beepOnce() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const beep = (freq, startOffset, duration) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square'; // brighter / more attention-grabbing than sine
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);

    const t0 = ctx.currentTime + startOffset;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.6, t0 + 0.02); // quick attack
    gain.gain.setValueAtTime(0.6, t0 + duration - 0.04);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);

    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  };

  beep(900, 0,    0.18); // first chirp
  beep(650, 0.22, 0.18); // second chirp — distinctive two-tone
}

function startBeeping() {
  if (beepingActive) return;
  if (!audioUnlocked) return; // browser will silently block until a gesture
  beepingActive = true;
  beepOnce();
  beepTimer = setInterval(beepOnce, 1400); // every 1.4 s — urgent but not a klaxon
}

function stopBeeping() {
  beepingActive = false;
  if (beepTimer) { clearInterval(beepTimer); beepTimer = null; }
}

// ─── Title bar flash — catches the eye even when tab is in the background ────
let titleFlashTimer = null;
let originalTitle   = null;
function startTitleFlash() {
  if (titleFlashTimer) return;
  originalTitle = document.title;
  let on = false;
  titleFlashTimer = setInterval(() => {
    on = !on;
    document.title = on ? '🚨 SOS ALERT — open admin' : (originalTitle || 'SAN Queue Admin');
  }, 900);
}
function stopTitleFlash() {
  if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
  if (originalTitle != null) { document.title = originalTitle; originalTitle = null; }
}

// ─── OS-level Notification (works while tab is in background) ────────────────
function fireDesktopNotification(alert) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const vehicle = alert.driver_vehicle_number ? ` (#${alert.driver_vehicle_number})` : '';
  try {
    const n = new Notification('🚨 SOS Alert', {
      body: `${alert.driver_name || 'Driver'}${vehicle} needs help — open the admin panel now.`,
      tag:  `sos-${alert.id}`,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      if (typeof showPage === 'function') showPage('page-sos');
      n.close();
    };
  } catch { /* iOS Safari etc. — non-fatal */ }
}

// ─── Public lifecycle hooks (called by admin app.js) ─────────────────────────
function onSosPageShow() {
  refreshSosList();
  ensureSosStreamConnected();
}
function onSosPageHide() { /* stream stays connected globally */ }

window.onSosPageShow = onSosPageShow;
window.onSosPageHide = onSosPageHide;

// ─── Stream wiring ────────────────────────────────────────────────────────────
function setStreamStatus(state) {
  const dot   = document.getElementById('sos-stream-dot');
  const label = document.getElementById('sos-stream-label');
  if (!dot || !label) return;
  if (state === 'connected') {
    dot.style.background = 'var(--green)';
    dot.style.boxShadow  = '0 0 6px var(--green)';
    label.textContent    = 'Live';
  } else if (state === 'reconnecting') {
    dot.style.background = 'var(--amber)';
    dot.style.boxShadow  = '0 0 6px var(--amber)';
    label.textContent    = 'Reconnecting…';
  } else {
    dot.style.background = 'var(--muted)';
    dot.style.boxShadow  = 'none';
    label.textContent    = 'Disconnected';
  }
}

function ensureSosStreamConnected() {
  if (sosSSE && sosSSE.readyState !== 2 /* CLOSED */) return;

  setStreamStatus('reconnecting');
  sosSSE = new EventSource('/api/admin/sos/stream', { withCredentials: true });

  sosSSE.onopen    = () => setStreamStatus('connected');
  sosSSE.onerror   = () => {
    setStreamStatus('reconnecting');
    // EventSource auto-reconnects, but if it goes to CLOSED, retry manually.
    setTimeout(() => {
      if (sosSSE && sosSSE.readyState === 2) ensureSosStreamConnected();
    }, 5000);
  };

  sosSSE.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleSosEvent(evt);
  };
}

function handleSosEvent(evt) {
  if (evt.type === 'sos.hello') return;

  if (evt.type === 'sos.new') {
    sosAlertsById.set(evt.payload.id, evt.payload);
    sosOpenCount++;
    updateNavBadge();
    showGlobalBanner(evt.payload);
    startBeeping();
    startTitleFlash();
    fireDesktopNotification(evt.payload);
    renderOpenAlerts();
    return;
  }

  if (evt.type === 'sos.updated' || evt.type === 'sos.location') {
    const merged = { ...(sosAlertsById.get(evt.payload.id) || {}), ...evt.payload };
    sosAlertsById.set(evt.payload.id, merged);

    if (evt.type === 'sos.updated' && merged.status === 'resolved') {
      sosOpenCount = Math.max(0, sosOpenCount - 1);
      updateNavBadge();
      if (sosOpenCount === 0) {
        hideGlobalBanner();
        stopBeeping();
        stopTitleFlash();
      }
      renderHistory();
    }
    // Acknowledging silences the noise but keeps the alert visible.
    if (evt.type === 'sos.updated' && merged.status === 'acknowledged') {
      stopBeeping();
    }
    renderOpenAlerts();
    return;
  }
}

// ─── REST: initial list ───────────────────────────────────────────────────────
async function refreshSosList() {
  let data;
  try {
    data = await api('/api/admin/sos?limit=100');
  } catch (err) {
    showToast(err.message || 'Could not load SOS alerts', 'error');
    return;
  }
  if (!data) return;

  sosAlertsById.clear();
  for (const a of data.alerts) sosAlertsById.set(a.id, a);

  sosOpenCount = data.openCount || 0;
  updateNavBadge();

  // Banner state: show for newest open alert if any. If any unacked alert
  // exists, also start the beep / title flash — admin may have just loaded the
  // page mid-emergency (e.g. they refreshed after the SSE event already fired).
  const openest = data.alerts.find((a) => a.status === 'active' || a.status === 'acknowledged');
  if (openest) {
    showGlobalBanner(openest);
    if (data.alerts.some((a) => a.status === 'active')) {
      startBeeping();
      startTitleFlash();
    }
  } else {
    hideGlobalBanner();
    stopBeeping();
    stopTitleFlash();
  }

  renderOpenAlerts();
  renderHistory();
}

// ─── Render: open alerts ──────────────────────────────────────────────────────
function renderOpenAlerts() {
  const wrap = document.getElementById('sos-active-list');
  if (!wrap) return;

  const open = Array.from(sosAlertsById.values())
    .filter((a) => a.status === 'active' || a.status === 'acknowledged')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  document.getElementById('sos-open-count').textContent = `(${open.length})`;

  if (!open.length) {
    wrap.innerHTML = `<div style="color:var(--muted2);font-size:14px;text-align:center;padding:24px;background:var(--bg2);border:1px dashed var(--border);border-radius:12px;">No active alerts.</div>`;
    return;
  }

  wrap.innerHTML = open.map(renderAlertCard).join('');
  wireCardActions();
}

// PG DECIMAL columns come back as strings — coerce before .toFixed / arithmetic.
const num = (v) => (v == null ? null : Number(v));

function renderAlertCard(a) {
  const lat = num(a.latest_lat), lng = num(a.latest_lng), acc = num(a.latest_accuracy);
  const ackClass = a.status === 'acknowledged' ? ' acknowledged' : '';
  const pill = a.status === 'acknowledged'
    ? '<span class="pill ack">Acknowledged</span>'
    : '<span class="pill active">Active</span>';
  const triggered = new Date(a.created_at).toLocaleString();
  const ackedBy   = a.acknowledged_at
    ? `Acknowledged ${new Date(a.acknowledged_at).toLocaleTimeString()}`
    : '';

  const phone = a.driver_phone ? `<a href="tel:${esc(a.driver_phone)}" style="color:var(--teal);text-decoration:none;">📞 ${esc(a.driver_phone)}</a>` : '<span style="color:var(--muted);">No phone on file</span>';

  const placeLine = a.place_name
    ? `<div style="font-size:15px;font-weight:600;color:#fff;line-height:1.35;">${esc(a.place_name)}</div>`
    : `<div style="font-size:13px;color:var(--muted2);font-style:italic;">Looking up address…</div>`;

  const locBlock = (lat != null && lng != null)
    ? `
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">
        <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;">
          ${a.live_tracking ? '📡 Live location' : '📍 Last known location'}
          ${acc != null ? `<span style="color:var(--muted2);text-transform:none;letter-spacing:0;margin-left:4px;">±${Math.round(acc)} m</span>` : ''}
        </div>
        ${placeLine}
        <div style="font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace;">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
          <a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${lat},${lng}">Open in Google Maps</a>
          <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://maps.apple.com/?q=${lat},${lng}">Apple Maps</a>
          <button class="btn btn-ghost btn-sm sos-copy-coords" data-coords="${lat},${lng}">Copy</button>
        </div>
      </div>`
    : `<div style="margin-top:12px;font-size:13px;color:var(--muted2);">📍 Location not yet shared. Driver may have denied GPS access.</div>`;

  const messageBlock = a.message
    ? `<div style="margin-top:10px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;color:#fff;">${esc(a.message)}</div>`
    : '';

  const ackBtn = a.status === 'active'
    ? `<button class="btn btn-primary btn-sm sos-ack-btn" data-id="${a.id}">Acknowledge</button>`
    : '';
  const resolveBtn = `<button class="btn btn-ghost btn-sm sos-resolve-btn" data-id="${a.id}">Mark Resolved</button>`;

  return `
    <div class="sos-card${ackClass}" data-id="${a.id}">
      <div class="row">
        <div style="flex:1;min-width:0;">
          <div class="driver-name">${esc(a.driver_name || 'Unknown driver')}</div>
          <div class="meta">Vehicle #${esc(a.driver_vehicle_number || '—')} · Triggered ${triggered}${ackedBy ? ' · ' + ackedBy : ''}</div>
          <div class="meta" style="margin-top:6px;">${phone}${a.driver_email ? ` · <a href="mailto:${esc(a.driver_email)}" style="color:var(--muted2);text-decoration:none;">${esc(a.driver_email)}</a>` : ''}</div>
        </div>
        ${pill}
      </div>
      ${messageBlock}
      ${locBlock}
      <div class="actions">
        ${ackBtn}
        ${resolveBtn}
      </div>
    </div>
  `;
}

function wireCardActions() {
  document.querySelectorAll('.sos-ack-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      b.disabled = true; b.textContent = 'Acknowledging…';
      try {
        await api(`/api/admin/sos/${id}/acknowledge`, { method: 'POST' });
      } catch (err) {
        showToast(err.message || 'Could not acknowledge', 'error');
        b.disabled = false; b.textContent = 'Acknowledge';
      }
    });
  });
  document.querySelectorAll('.sos-resolve-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const ok = await confirmSosResolve();
      if (!ok) return;
      b.disabled = true; b.textContent = 'Resolving…';
      try {
        await api(`/api/admin/sos/${id}/resolve`, { method: 'POST' });
      } catch (err) {
        showToast(err.message || 'Could not resolve', 'error');
        b.disabled = false; b.textContent = 'Mark Resolved';
      }
    });
  });
  document.querySelectorAll('.sos-copy-coords').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.coords);
      showToast('Coordinates copied', 'success', 1500);
    });
  });
}

// ─── Render: history table ────────────────────────────────────────────────────
function renderHistory() {
  const tbody = document.getElementById('sos-history-tbody');
  if (!tbody) return;

  const resolved = Array.from(sosAlertsById.values())
    .filter((a) => a.status === 'resolved')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);

  if (!resolved.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:18px;">No resolved alerts yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = resolved.map((a) => {
    const triggered = new Date(a.created_at).toLocaleString();
    const resolved  = a.resolved_at ? new Date(a.resolved_at).toLocaleString() : '—';
    const reason    = a.resolution_reason === 'driver_cancelled' ? 'Driver cancelled' : 'Admin resolved';
    const lat = num(a.latest_lat), lng = num(a.latest_lng);
    const loc = (lat != null && lng != null)
      ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${lat},${lng}" style="color:var(--teal);text-decoration:none;">${esc(a.place_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`)}</a>`
      : '<span style="color:var(--muted);">—</span>';
    return `
      <tr>
        <td>${esc(a.driver_name || '—')}</td>
        <td class="mono">${esc(a.driver_vehicle_number || '—')}</td>
        <td>${triggered}</td>
        <td>${resolved}</td>
        <td>${reason}</td>
        <td>${loc}</td>
      </tr>`;
  }).join('');
}

// ─── Banner + sound + badge ───────────────────────────────────────────────────
function updateNavBadge() {
  const badge = document.getElementById('sos-nav-badge');
  if (!badge) return;
  if (sosOpenCount > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent   = String(sosOpenCount);
  } else {
    badge.style.display = 'none';
  }
}

function showGlobalBanner(alert) {
  const banner = document.getElementById('sos-global-banner');
  const detail = document.getElementById('sos-banner-detail');
  if (!banner || !detail) return;

  const vehicle = alert.driver_vehicle_number ? ` (#${alert.driver_vehicle_number})` : '';
  detail.textContent = `${alert.driver_name || 'Driver'}${vehicle} — open the SOS page now`;
  banner.style.display = 'block';
}

function hideGlobalBanner() {
  const banner = document.getElementById('sos-global-banner');
  if (banner) banner.style.display = 'none';
}

// Audio unlock: browsers gate AudioContext until the user has interacted with
// the page. As soon as the admin clicks anywhere we resume the context and
// also ask for Notification permission so OS-level pop-ups work when the tab
// is in the background. Both are no-ops if already done.
function unlockAudioOnce() {
  if (audioUnlocked) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  ctx.resume().then(() => { audioUnlocked = true; }).catch(() => {});

  // Best-effort: request OS notifications on first click too. If the admin
  // says no we just fall back to the in-tab beep + title flash.
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch { /* ignore */ }
  }
}
document.addEventListener('click',   unlockAudioOnce);
document.addEventListener('keydown', unlockAudioOnce);

// ─── Banner buttons + manual controls ─────────────────────────────────────────
document.getElementById('sos-banner-open')?.addEventListener('click', () => {
  if (typeof showPage === 'function') showPage('page-sos');
  hideGlobalBanner();
  stopBeeping();
  stopTitleFlash();
});
document.getElementById('sos-banner-dismiss')?.addEventListener('click', () => {
  hideGlobalBanner();
  stopBeeping();
  stopTitleFlash();
});
// ─── Styled "are you sure?" modal — replaces native confirm() ─────────────────
function confirmSosResolve() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('sos-confirm-modal');
    const okBtn   = document.getElementById('sos-confirm-ok');
    const cancel  = document.getElementById('sos-confirm-cancel');
    if (!overlay || !okBtn || !cancel) { resolve(window.confirm('Mark this SOS alert as resolved?')); return; }

    const close = (val) => {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk      = () => close(true);
    const onCancel  = () => close(false);
    const onBackdrop = (e) => { if (e.target === overlay) close(false); };
    const onKey     = (e) => { if (e.key === 'Escape') close(false); };

    okBtn.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    overlay.classList.add('open');
  });
}

document.getElementById('btn-sos-refresh')?.addEventListener('click', refreshSosList);
document.getElementById('btn-sos-enable-push')?.addEventListener('click', enablePushNotifications);
document.getElementById('btn-sos-test-sound')?.addEventListener('click', () => {
  unlockAudioOnce();
  beepOnce();
  showToast('Test beep played — if you didn\'t hear it, check your system volume / tab mute', 'info', 4000);
});

// ─── Web Push subscribe ───────────────────────────────────────────────────────
async function enablePushNotifications() {
  const btn = document.getElementById('btn-sos-enable-push');
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showToast('This browser does not support push notifications', 'error');
      return;
    }

    const cfg = await api('/api/admin/sos/push/config');
    if (!cfg?.enabled || !cfg.publicKey) {
      showToast('Push not configured on server (set VAPID_* env vars)', 'error', 5000);
      return;
    }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showToast('Notifications permission denied', 'error');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
    });

    await api('/api/admin/sos/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub.toJSON()),
    });

    btn.textContent = '🔔 Push Enabled';
    btn.disabled = true;
    showToast('Push notifications enabled — you will be alerted even when this tab is closed', 'success', 5000);
  } catch (err) {
    showToast(err.message || 'Could not enable push', 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Stream connects as soon as we know the admin is authenticated. admin/app.js
// calls window.startSosStream() after its session check passes.
window.startSosStream = function () {
  ensureSosStreamConnected();
  refreshSosList();
};
