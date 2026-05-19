// ─── Admin App — Entry Point ──────────────────────────────────────────────────
// Loaded last. All controllers are already parsed and their event listeners
// wired. This file:
//   1. Defines showLoginPage()
//   2. Overrides api() with the admin version (401 → showLoginPage, not throw)
//   3. Defines showPage() and wires the nav links
//   4. Runs the boot sequence
//   5. Starts the auto-refresh interval for the logs page

// ─── Show the login screen, hide the sidebar ──────────────────────────────────
function showLoginPage() {
  document.getElementById('sidebar').style.display = 'none';
  showPage('page-login');
}

// ─── Admin-specific api() ─────────────────────────────────────────────────────
// Overrides the base api() from utils.js.
// Key difference: a 401 response silently redirects to the login page
// instead of throwing an error (avoids "Invalid email or password" flash).
// All callers must guard against a null return value.
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
  if (res.status === 401) { showLoginPage(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyHttpError(res.status, data.error));
  return data;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const CONTENT_PAGES = ['page-overview', 'page-drivers', 'page-logs', 'page-monitor', 'page-watchlist'];

let _activePage = null; // track current page for hide callbacks

function showPage(pageId) {
  // Fire hide callbacks for the page we're leaving
  if (_activePage === 'page-monitor'   && pageId !== 'page-monitor')   { if (typeof onMonitorPageHide   === 'function') onMonitorPageHide();   }
  if (_activePage === 'page-watchlist' && pageId !== 'page-watchlist') { if (typeof onWatchlistPageHide === 'function') onWatchlistPageHide(); }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  document.querySelector(`[data-page="${pageId}"]`)?.classList.add('active');

  _activePage = pageId;

  // Persist the active content tab so it survives page refreshes
  if (CONTENT_PAGES.includes(pageId)) {
    localStorage.setItem('adminActivePage', pageId);
  }

  if (pageId === 'page-overview') loadOverview();
  if (pageId === 'page-drivers')  loadDrivers();
  if (pageId === 'page-logs')     loadLogs();
  if (pageId === 'page-monitor')   { if (typeof onMonitorPageShow   === 'function') onMonitorPageShow();   }
  if (pageId === 'page-watchlist') { if (typeof onWatchlistPageShow === 'function') onWatchlistPageShow(); }
}

// Wire sidebar nav links
document.querySelectorAll('.nav-link').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Ping the stats endpoint to check whether the admin session is still valid.
// Success → show the sidebar and restore the last active page.
// Failure → show the login screen.
(async () => {
  try {
    const data = await api('/api/admin/stats');
    if (data) {
      document.getElementById('sidebar').style.display = 'flex';
      const saved = localStorage.getItem('adminActivePage');
      showPage(CONTENT_PAGES.includes(saved) ? saved : 'page-overview');
    } else {
      showLoginPage();
    }
  } catch {
    showLoginPage();
  }
})();

// ─── Auto-refresh logs every 30 s when the logs page is active ───────────────
setInterval(() => {
  if (document.getElementById('page-logs').classList.contains('active')) loadLogs();
}, 30000);
