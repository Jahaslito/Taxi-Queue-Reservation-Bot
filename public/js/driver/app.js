// ─── Driver App — Entry Point ─────────────────────────────────────────────────
// Loaded last. By the time this script runs, all controllers and utils are
// already defined and available globally.
//
// Responsibilities:
//   • showView()  — the single navigation function all controllers call
//   • Nav-bar click wiring
//   • Boot sequence (session check → show correct initial view)
//   • URL query param handling (?verified=, ?reset=)

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

// ─── Resend verification email button ─────────────────────────────────────────
document.getElementById('btn-resend-verification').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = 'Sending…';
  try {
    await api('/api/auth/driver/resend-verification', { method: 'POST' });
    showToast('Verification email sent — check your inbox!', 'success');
    this.textContent = '✓ Sent';
  } catch (err) {
    showToast(err.message, 'error');
    this.disabled = false;
    this.textContent = 'Resend verification email';
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Try to load the profile using the existing session cookie.
// Success → go straight to the dashboard (or handle URL params first).
// Failure (401 / network error) → show the login screen (or reset view if ?reset= present).
(async () => {
  const params   = new URLSearchParams(window.location.search);
  const resetTok = params.get('reset');
  const verified = params.get('verified');

  // Clean the query string from the URL bar without reloading
  if (resetTok || verified) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  // ── ?reset=TOKEN — show set-new-password form ──────────────────────────────
  if (resetTok) {
    document.getElementById('reset-token').value = resetTok;
    showView('view-reset-password');
    return;
  }

  // ── Check existing session ─────────────────────────────────────────────────
  try {
    driverProfile = await api('/api/driver/profile');
    showView('view-dashboard');
    // ── ?verified=success|expired — show toast after dashboard loads ──────────
    if (verified === 'success') {
      showToast('✅ Email verified successfully!', 'success');
      // Update local profile so the banner hides without a reload
      if (driverProfile) driverProfile.email_verified_at = new Date().toISOString();
    } else if (verified === 'expired') {
      showToast('Verification link expired. Please request a new one.', 'error');
    }
  } catch {
    // Not logged in
    if (verified === 'success') {
      showView('view-login');
      showToast('✅ Email verified! Please log in.', 'success');
    } else if (verified === 'expired') {
      showView('view-login');
      showToast('Verification link expired. Log in and request a new one.', 'error');
    } else {
      showView('view-login');
    }
  }
})();
