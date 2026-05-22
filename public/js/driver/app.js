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
// Views that show the bottom nav bar (main app screens)
const MAIN_VIEWS = ['view-dashboard', 'view-schedule', 'view-history', 'view-account'];

function showView(viewId) {
  // Hide every view panel, then reveal the requested one
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');

  // Show the bottom nav bar only for the main app views
  document.getElementById('main-nav').style.display = MAIN_VIEWS.includes(viewId) ? 'flex' : 'none';

  // Highlight the matching nav item
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  // Trigger data loads for views that need fresh data every visit
  if (viewId === 'view-dashboard') loadDashboard();
  if (viewId === 'view-history')   loadHistory();
  if (viewId === 'view-schedule')  loadSchedule();
  if (viewId === 'view-account' && window.renderAccountSubscription) {
    window.renderAccountSubscription(driverProfile);
  }

  window.scrollTo(0, 0);
}

// ─── Route logged-in driver to the right view based on account state ──────────
// Called after login, registration, and on boot when a session exists.
function routeDriver(profile) {
  driverProfile = profile;

  // 1. Email not verified → show verification screen
  if (!profile.email_verified_at) {
    if (window.prepareVerifyEmailView) window.prepareVerifyEmailView(profile);
    showView('view-verify-email');
    return;
  }

  // 2. No active subscription → show billing screen
  const activeSubs = ['trialing', 'active'];
  if (!activeSubs.includes(profile.subscription_status)) {
    if (window.prepareBillingView) window.prepareBillingView(profile);
    showView('view-billing');
    return;
  }

  // 3. All good → dashboard
  showView('view-dashboard');
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
// Success → routeDriver() picks the right screen based on account state.
// Failure (401 / network error) → show the login screen.
(async () => {
  const params   = new URLSearchParams(window.location.search);
  const resetTok = params.get('reset');
  const verified = params.get('verified');
  const billing  = params.get('billing');

  // Clean query string from URL bar so Back button doesn't re-trigger
  if (resetTok || verified || billing) {
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
    const profile = await api('/api/driver/profile');

    // ?verified=success — email just verified, patch local state then re-route
    if (verified === 'success') {
      profile.email_verified_at = profile.email_verified_at || new Date().toISOString();
      showToast('✅ Email verified! Setting up billing…', 'success');
    } else if (verified === 'expired') {
      showToast('Verification link expired. Please request a new one.', 'error');
    }

    // ?billing=success — Stripe checkout just completed; may need a moment for
    // the webhook to fire. Poll profile up to 8 s until status becomes trialing/active.
    if (billing === 'success') {
      let resolved = ['trialing', 'active'].includes(profile.subscription_status);
      if (!resolved) {
        for (let i = 0; i < 4 && !resolved; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const fresh = await api('/api/driver/profile');
            Object.assign(profile, fresh);
            resolved = ['trialing', 'active'].includes(profile.subscription_status);
          } catch { break; }
        }
      }
      if (resolved) {
        showToast('🎉 Subscription active — welcome to SAN Queue!', 'success');
      } else {
        showToast('Billing is being processed — if access is still blocked in a minute, refresh the page.', 'success');
      }
    } else if (billing === 'canceled') {
      showToast('Billing setup was canceled. You can try again any time.', 'error');
    }

    routeDriver(profile);
  } catch {
    // Not logged in
    if (verified === 'success') {
      showView('view-login');
      showToast('✅ Email verified! Please log in to set up billing.', 'success');
    } else if (verified === 'expired') {
      showView('view-login');
      showToast('Verification link expired. Log in and request a new one.', 'error');
    } else {
      showView('view-login');
    }
  }
})();
