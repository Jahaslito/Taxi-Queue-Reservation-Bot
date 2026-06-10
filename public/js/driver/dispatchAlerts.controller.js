// ─── Driver Dispatch Alerts Controller ───────────────────────────────────────
// Opt-in toggle for the "you've been dispatched to T1/T2" notification.
//
// Wire-up:
//   1. On boot, fetch /api/driver/push/config to learn the VAPID public key
//      and whether the server has push enabled.
//   2. Button click flow:
//        a. Ask the browser for Notification.permission.
//        b. Register the service worker (already done globally — we just grab
//           the registration here).
//        c. Create a PushSubscription with the VAPID key.
//        d. POST endpoint + keys to /api/driver/push/subscribe.
//        e. Persist enabled state in localStorage so the UI reflects it
//           across reloads without an extra round-trip.
//   3. A second click unsubscribes — both client-side (pushManager) and
//      server-side (DELETE row keyed by endpoint).
//
// Depends on: utils.js (api, showToast)

const ALERTS_STORAGE_KEY = 'dispatchAlerts:endpoint';

let vapidPublicKey = null;
let pushEnabledOnServer = false;
let busy = false;

function $da(id) { return document.getElementById(id); }

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function initDispatchAlerts() {
  const btn = $da('btn-dispatch-alerts');
  if (!btn) return; // index.html missing the button — controller is no-op

  // Hide the button if the browser can't do Web Push at all (older Safari,
  // some embedded webviews). The driver can still receive SMS — that path
  // doesn't need the browser to participate.
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.style.display = 'none';
    return;
  }

  try {
    const cfg = await api('/api/driver/push/config');
    pushEnabledOnServer = !!cfg.enabled;
    vapidPublicKey      = cfg.publicKey || null;
  } catch {
    // Endpoint not deployed yet or auth glitch — bail silently. The button
    // stays hidden so the driver doesn't see a broken control.
    btn.style.display = 'none';
    return;
  }

  if (!pushEnabledOnServer || !vapidPublicKey) {
    // Server isn't set up for push (no VAPID keys). SMS still works server-
    // side via Telnyx; the UI just hides the push toggle.
    btn.style.display = 'none';
    return;
  }

  await refreshButtonState();
  btn.addEventListener('click', onButtonClick);
}

// ─── State sync ───────────────────────────────────────────────────────────────
// Pulls the live PushSubscription from the browser. localStorage is a hint —
// authoritative state is the browser's own subscription registry, which can
// be revoked from OS settings without our app knowing.
async function refreshButtonState() {
  const reg  = await navigator.serviceWorker.ready;
  const sub  = await reg.pushManager.getSubscription();

  const enabled = !!sub;
  setButtonAppearance(enabled);

  if (enabled) {
    localStorage.setItem(ALERTS_STORAGE_KEY, sub.endpoint);
  } else {
    localStorage.removeItem(ALERTS_STORAGE_KEY);
  }
}

function setButtonAppearance(enabled) {
  const label = $da('btn-dispatch-alerts-label');
  const sub   = $da('btn-dispatch-alerts-sub');
  const icon  = $da('btn-dispatch-alerts-icon');
  if (!label || !sub || !icon) return;

  if (enabled) {
    label.textContent = 'Dispatch alerts ON';
    sub.textContent   = "Tap to disable. You'll still get SMS.";
    icon.textContent  = '🔕';
  } else {
    label.textContent = 'Enable dispatch alerts';
    sub.textContent   = "Get a push + SMS when you're sent to T1 or T2";
    icon.textContent  = '🔔';
  }
}

function setBusy(b) {
  busy = b;
  const spinner = $da('btn-dispatch-alerts-spinner');
  const btn     = $da('btn-dispatch-alerts');
  if (spinner) spinner.style.display = b ? 'inline-block' : 'none';
  if (btn)     btn.style.opacity     = b ? '0.6' : '1';
}

// ─── Toggle ───────────────────────────────────────────────────────────────────
async function onButtonClick() {
  if (busy) return;
  setBusy(true);
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await disable(existing);
    } else {
      await enable(reg);
    }
  } catch (err) {
    showToast(err.message || 'Could not update dispatch alerts', 'error');
  } finally {
    setBusy(false);
    await refreshButtonState().catch(() => {});
  }
}

async function enable(reg) {
  // Browsers gate push behind explicit user permission. If the driver
  // previously denied, we can't re-prompt — they'd have to flip the system
  // setting manually. Surface that with a clear toast instead of failing
  // silently inside subscribe().
  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked. Enable them in your browser settings and try again.');
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly:      true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = sub.toJSON();
  await api('/api/driver/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys:     json.keys,
    }),
  });

  showToast('Dispatch alerts enabled', 'success');
}

async function disable(sub) {
  const endpoint = sub.endpoint;
  // Unsubscribe browser-side first — even if the server call fails, the
  // browser stops delivering notifications. Then DELETE the row so we don't
  // keep trying to push to a dead endpoint.
  try { await sub.unsubscribe(); } catch { /* ignore */ }
  try {
    await api('/api/driver/push/unsubscribe', {
      method: 'POST',
      body:   JSON.stringify({ endpoint }),
    });
  } catch (err) {
    // Non-fatal — server-side cleanup will eventually happen via the 410
    // prune path the next time the service tries to push to this endpoint.
    console.warn('[DispatchAlerts] Server unsubscribe failed:', err.message);
  }
  showToast('Dispatch alerts disabled', 'success');
}

// ─── VAPID key encoding ───────────────────────────────────────────────────────
// Standard helper used everywhere Web Push is set up — converts the URL-safe
// base64 public key the server emits into the Uint8Array shape PushManager
// requires for `applicationServerKey`.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  const out     = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Expose to app.js so it can call from showView() when the dashboard mounts.
// Same pattern as bootSos in sos.controller.js.
window.initDispatchAlerts = initDispatchAlerts;
