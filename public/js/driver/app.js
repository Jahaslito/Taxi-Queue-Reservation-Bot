// ─── Driver App — Entry Point ─────────────────────────────────────────────────
// Loaded last. By the time this script runs, all controllers and utils are
// already defined and available globally.
//
// Responsibilities:
//   • showView()  — the single navigation function all controllers call
//   • Nav-bar click wiring
//   • Boot sequence (session check → show correct initial view)

// ─── Navigation ───────────────────────────────────────────────────────────────
function showView(viewId) {
  // Hide every view panel, then reveal the requested one
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');

  // Show the bottom nav bar only when the user is logged in
  const isLoggedIn = ['view-dashboard', 'view-schedule', 'view-history', 'view-account'].includes(viewId);
  document.getElementById('main-nav').style.display = isLoggedIn ? 'flex' : 'none';

  // Highlight the matching nav item
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  // Trigger data loads for views that need fresh data every visit
  if (viewId === 'view-dashboard') loadDashboard();
  if (viewId === 'view-history')   loadHistory();
  if (viewId === 'view-schedule')  loadSchedule();

  window.scrollTo(0, 0);
}

// ─── Nav bar click wiring ─────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Try to load the profile using the existing session cookie.
// Success → go straight to the dashboard.
// Failure (401 / network error) → show the login screen.
(async () => {
  try {
    driverProfile = await api('/api/driver/profile');
    showView('view-dashboard');
  } catch {
    showView('view-login');
  }
})();
