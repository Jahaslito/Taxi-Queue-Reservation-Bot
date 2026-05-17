// ─── Admin Auth Controller ────────────────────────────────────────────────────
// Handles: admin login form, logout button.
// Calls showPage() and showLoginPage() at runtime only — defined in app.js.
// Depends on: utils.js (api, esc, showToast)

// ─── Admin login ──────────────────────────────────────────────────────────────
document.getElementById('btn-admin-login').addEventListener('click', async () => {
  const username = document.getElementById('admin-username-input').value.trim();
  const password = document.getElementById('admin-password-input').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';

  const btn = document.getElementById('btn-admin-login');
  btn.innerHTML = '<span class="spinner"></span> Signing in…'; btn.disabled = true;

  try {
    const data = await api('/api/auth/admin/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    });
    if (!data) return; // 401 already handled by api()

    document.getElementById('admin-name').textContent   = esc(data.admin.username);
    document.getElementById('admin-avatar').textContent = esc(data.admin.username[0].toUpperCase());
    document.getElementById('sidebar').style.display    = 'flex';
    showPage('page-overview');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Sign In'; btn.disabled = false;
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  localStorage.removeItem('adminActivePage');
  showLoginPage();
});
