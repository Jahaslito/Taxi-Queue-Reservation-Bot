// ─── Shared utilities ─────────────────────────────────────────────────────────
// Loaded first on the driver page. All symbols declared here are available
// globally to every controller script that follows.

const API = ''; // same-origin — no URL prefix needed

// ─── Shared mutable state ─────────────────────────────────────────────────────
// Declared here so every controller that loads after this file can read and
// write driverProfile without an import system.
let driverProfile = null;

// ─── XSS protection ──────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success', duration = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), duration);
}

// ─── API helper ──────────────────────────────────────────────────────────────
function friendlyNetworkError() {
  // Local-dev only: warn when accidentally hitting https on a non-TLS dev server.
  // In production the site is always HTTPS (required for PWA install + service
  // workers), so this branch never fires.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (isLocal && location.protocol === 'https:') {
    return 'Local dev tip — open this page via http:// instead of https://';
  }
  return 'Connection failed. Please check your internet and try again.';
}

function friendlyHttpError(status, serverMsg) {
  if (status === 401) return 'Invalid email or password.';
  if (status === 429) return 'Too many attempts. Please wait 15 minutes and try again.';
  if (status === 403) return 'Access denied.';
  if (status === 404) return 'Resource not found.';
  if (status >= 500)  return 'Server error. Please try again in a moment.';
  return serverMsg || 'Something went wrong. Please try again.';
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new Error(friendlyNetworkError());
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyHttpError(res.status, data.error));
  return data;
}

// ─── Day picker helpers ───────────────────────────────────────────────────────
function getDayPickerValue(pickerId) {
  const btns = document.querySelectorAll(`#${pickerId} .day-btn`);
  const active = [];
  btns.forEach(btn => { if (btn.classList.contains('active')) active.push(btn.dataset.day); });
  return active.join(',') || '0,1,2,3,4,5,6';
}

function setDayPickerValue(pickerId, value) {
  const days = (value || '0,1,2,3,4,5,6').split(',').map(Number);
  const btns = document.querySelectorAll(`#${pickerId} .day-btn`);
  btns.forEach(btn => {
    btn.classList.toggle('active', days.includes(Number(btn.dataset.day)));
  });
}
