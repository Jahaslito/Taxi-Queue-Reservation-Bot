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
  document.body.classList.remove('nav-ready');       // hide the mobile top bar on the login screen
  document.body.classList.remove('role-insurance');  // reset any role scoping
  if (typeof window.closeSidebarDrawer === 'function') window.closeSidebarDrawer();
  showPage('page-login');
}

// ─── Role-based UI ────────────────────────────────────────────────────────────
// An 'insurance' admin sees ONLY the Insurance section. This is presentation
// only — the server independently enforces access (middleware/auth.js), so a
// hidden nav is never the security boundary.
function applyAdminRole(role) {
  window.adminRole = role || 'super_admin';
  document.body.classList.toggle('role-insurance', role === 'insurance');
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
const CONTENT_PAGES = ['page-overview', 'page-drivers', 'page-logs', 'page-monitor', 'page-watchlist', 'page-pos-tracking', 'page-pos-diagnostics', 'page-sos', 'page-messages', 'page-insurance'];

let _activePage = null; // track current page for hide callbacks

function showPage(pageId) {
  // Fire hide callbacks for the page we're leaving
  if (_activePage === 'page-monitor'   && pageId !== 'page-monitor')   { if (typeof onMonitorPageHide   === 'function') onMonitorPageHide();   }
  if (_activePage === 'page-watchlist' && pageId !== 'page-watchlist') { if (typeof onWatchlistPageHide === 'function') onWatchlistPageHide(); }
  if (_activePage === 'page-sos'       && pageId !== 'page-sos')       { if (typeof onSosPageHide       === 'function') onSosPageHide();       }

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
  if (pageId === 'page-monitor')      { if (typeof onMonitorPageShow   === 'function') onMonitorPageShow();   }
  if (pageId === 'page-watchlist')    { if (typeof onWatchlistPageShow === 'function') onWatchlistPageShow(); }
  if (pageId === 'page-pos-tracking')    { loadPosTracking(); if (typeof loadCarryoverReport === 'function') loadCarryoverReport(); }
  if (pageId === 'page-pos-diagnostics') { loadPosDiagnostics(); if (typeof loadTerminalMetrics === 'function') loadTerminalMetrics(); }
  if (pageId === 'page-sos')             { if (typeof onSosPageShow       === 'function') onSosPageShow();       }
  if (pageId === 'page-messages')        { if (typeof onMessagesPageShow  === 'function') onMessagesPageShow();  }
  if (pageId === 'page-insurance')       { if (typeof loadInsurance       === 'function') loadInsurance();       }
}

// Wire sidebar nav links
document.querySelectorAll('.nav-link').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// ─── Mobile sidebar drawer (hamburger open/close) ────────────────────────────
// The sidebar collapses to a slide-out drawer at ≤768px. The hamburger toggles
// it; the backdrop, the in-drawer ✕, Escape, and choosing a nav item all close
// it. No-ops on desktop where the sidebar is always visible.
(function initSidebarDrawer() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebar-overlay');
  const btn      = document.getElementById('hamburger-btn');
  const closeBtn = document.getElementById('sidebar-close');
  if (!sidebar || !overlay || !btn) return;

  function setOpen(open) {
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    btn.textContent = open ? '✕' : '☰';
    document.body.style.overflow = open ? 'hidden' : '';   // lock background scroll while the drawer is open
  }
  // Exposed so the auth flow can force the drawer shut on logout / 401.
  window.closeSidebarDrawer = () => setOpen(false);

  btn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  overlay.addEventListener('click', () => setOpen(false));
  closeBtn?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // Choosing a destination closes the drawer so you land on the page, not the menu.
  document.querySelectorAll('.nav-link').forEach(n => n.addEventListener('click', () => setOpen(false)));
  // Returning to desktop width resets state so a lingering drawer/backdrop can't stick.
  window.addEventListener('resize', () => { if (window.innerWidth > 768) setOpen(false); });
})();

// ─── Desktop sidebar collapse (arrow handle) ─────────────────────────────────
// On wide screens (>768px) the sidebar is persistent; this arrow collapses it to
// reclaim space and expands it back. The arrow points IN (◀) when open and OUT
// (▶) when collapsed. The choice persists across reloads. On mobile the handle
// is hidden (the hamburger drawer is used instead) and this state is inert.
(function initSidebarCollapse() {
  const toggle = document.getElementById('sidebar-toggle');
  if (!toggle) return;
  const KEY = 'adminNavCollapsed';

  function apply(collapsed) {
    document.body.classList.toggle('nav-collapsed', collapsed);
    toggle.textContent = collapsed ? '▶' : '◀';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.setAttribute('title',      collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  let saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch { /* storage blocked */ }
  apply(saved);

  toggle.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('nav-collapsed');
    apply(collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  });
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Ping the stats endpoint to check whether the admin session is still valid.
// Success → show the sidebar and restore the last active page.
// Failure → show the login screen.
(async () => {
  try {
    // Role-aware session probe: tells us whether the session is valid AND which
    // access role to render (super_admin = everything, insurance = portal only).
    const me = await api('/api/admin/me');
    if (me) {
      document.getElementById('sidebar').style.display = 'flex';
      document.body.classList.add('nav-ready');    // reveal the mobile top bar once authed
      if (me.username) {
        document.getElementById('admin-name').textContent   = me.username;
        document.getElementById('admin-avatar').textContent = me.username[0].toUpperCase();
      }
      applyAdminRole(me.role);
      if (me.role === 'insurance') {
        showPage('page-insurance');
      } else {
        const saved = localStorage.getItem('adminActivePage');
        showPage(CONTENT_PAGES.includes(saved) ? saved : 'page-overview');
        // SOS stream connects globally — alerts must surface on ANY admin page.
        if (typeof window.startSosStream === 'function') window.startSosStream();
      }
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
