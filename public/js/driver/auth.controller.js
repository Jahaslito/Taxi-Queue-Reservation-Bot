// ─── Driver Auth Controller ───────────────────────────────────────────────────
// Handles: login, register, forgot password, logout, change password.
// Depends on: utils.js (api, showToast, getDayPickerValue, esc)
// Calls:      showView() — defined in app.js, safe because these are only
//             invoked at runtime (click events), never at parse time.

// ─── View-navigation helpers (auth screens) ───────────────────────────────────
document.getElementById('btn-show-register').addEventListener('click', () => showView('view-register'));
document.getElementById('btn-back-login').addEventListener('click',    () => showView('view-login'));

document.getElementById('btn-show-forgot').addEventListener('click', () => {
  document.getElementById('forgot-error').textContent = '';
  document.getElementById('forgot-success-box').style.display = 'none';
  document.getElementById('forgot-email').value = '';
  showView('view-forgot');
});

document.getElementById('btn-forgot-back').addEventListener('click', () => showView('view-login'));

// ─── Forgot password — send reset link ───────────────────────────────────────
document.getElementById('btn-forgot-submit').addEventListener('click', async () => {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-error');
  errEl.textContent = '';
  document.getElementById('forgot-success-box').style.display = 'none';

  if (!email) { errEl.textContent = 'Please enter your email address.'; return; }

  const btn = document.getElementById('btn-forgot-submit');
  btn.innerHTML = '<span class="spinner"></span> Sending…'; btn.disabled = true;

  try {
    await api('/api/auth/driver/forgot-password', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    document.getElementById('forgot-email').value = '';
    document.getElementById('forgot-success-box').style.display = 'block';
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Send Reset Link'; btn.disabled = false;
  }
});

// ─── Reset password — confirm new password (linked from email) ────────────────
document.getElementById('btn-reset-submit').addEventListener('click', async () => {
  const token       = document.getElementById('reset-token').value;
  const newPassword = document.getElementById('reset-new-password').value;
  const confirm     = document.getElementById('reset-confirm-password').value;
  const errEl       = document.getElementById('reset-error');
  errEl.textContent = '';
  document.getElementById('reset-success-box').style.display = 'none';

  if (!newPassword || !confirm)   { errEl.textContent = 'Please fill in both password fields.'; return; }
  if (newPassword.length < 6)     { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (newPassword !== confirm)    { errEl.textContent = 'Passwords do not match.'; return; }

  const btn = document.getElementById('btn-reset-submit');
  btn.innerHTML = '<span class="spinner"></span> Updating…'; btn.disabled = true;

  try {
    await api('/api/auth/driver/reset-password', {
      method: 'POST', body: JSON.stringify({ token, newPassword }),
    });
    document.getElementById('reset-new-password').value    = '';
    document.getElementById('reset-confirm-password').value = '';
    document.getElementById('reset-success-box').style.display = 'block';
    btn.style.display = 'none';
    // After 2.5 s take them to login
    setTimeout(() => { btn.style.display = ''; showView('view-login'); }, 2500);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Set New Password'; btn.disabled = false;
  }
});

document.getElementById('btn-reset-back').addEventListener('click', () => showView('view-login'));

// ─── Login ───────────────────────────────────────────────────────────────────
document.getElementById('btn-login').addEventListener('click', async () => {
  const identifier = document.getElementById('login-identifier').value.trim();
  const password   = document.getElementById('login-password').value;
  const errEl      = document.getElementById('login-error');
  errEl.textContent = '';

  if (!identifier || !password) { errEl.textContent = 'Please fill in all fields'; return; }

  const btn = document.getElementById('btn-login');
  btn.innerHTML = '<span class="spinner"></span> Logging in…'; btn.disabled = true;

  try {
    const body = { email: identifier, appPassword: password };
    const data = await api('/api/auth/driver/login', { method: 'POST', body: JSON.stringify(body) });
    routeDriver(data.driver);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Log In'; btn.disabled = false;
  }
});

// ─── Register ────────────────────────────────────────────────────────────────
document.getElementById('btn-register').addEventListener('click', async () => {
  const name          = document.getElementById('reg-name').value.trim();
  const phone         = document.getElementById('reg-phone').value.trim();
  const email         = document.getElementById('reg-email').value.trim();
  const appPassword   = document.getElementById('reg-app-password').value;
  const sanUsername   = document.getElementById('reg-san-username').value.trim();
  const sanPassword   = document.getElementById('reg-san-password').value;
  const vehicleNumber = document.getElementById('reg-vehicle').value.trim();
  const errEl         = document.getElementById('reg-error');
  errEl.textContent   = '';

  if (!name || !appPassword || !sanUsername || !sanPassword || !vehicleNumber) {
    errEl.textContent = 'Please fill in all required fields'; return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'A valid email address is required'; return;
  }

  const btn = document.getElementById('btn-register');
  btn.innerHTML = '<span class="spinner"></span> Creating account…'; btn.disabled = true;

  try {
    const data = await api('/api/auth/driver/register', {
      method: 'POST',
      body: JSON.stringify({ name, phone, email, appPassword, sanUsername, sanPassword, vehicleNumber }),
    });
    showToast('Account created! Welcome 🎉');
    routeDriver(data.driver);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Create Account'; btn.disabled = false;
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────
async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  driverProfile = null;
  showView('view-login');
}

document.getElementById('btn-logout-menu').addEventListener('click',           doLogout);
document.getElementById('btn-logout-account').addEventListener('click',        doLogout);
document.getElementById('btn-logout-verify').addEventListener('click',         doLogout);
document.getElementById('btn-logout-billing').addEventListener('click',        doLogout);
document.getElementById('btn-logout-billing-manage').addEventListener('click', doLogout);

// ─── Change password ──────────────────────────────────────────────────────────
document.getElementById('btn-change-password').addEventListener('click', async () => {
  const current = document.getElementById('cp-current').value;
  const newPass = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;
  const errEl   = document.getElementById('cp-error');
  const okEl    = document.getElementById('cp-success');
  errEl.textContent = ''; okEl.style.display = 'none';

  if (!current || !newPass || !confirm) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (newPass.length < 6)               { errEl.textContent = 'New password must be at least 6 characters.'; return; }
  if (newPass !== confirm)              { errEl.textContent = 'Passwords do not match.'; return; }

  const btn = document.getElementById('btn-change-password');
  btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;

  try {
    await api('/api/driver/profile', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword: current, newAppPassword: newPass }),
    });
    okEl.textContent = 'Password updated successfully.';
    okEl.style.display = 'block';
    document.getElementById('cp-current').value = '';
    document.getElementById('cp-new').value     = '';
    document.getElementById('cp-confirm').value = '';
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.innerHTML = 'Update Password'; btn.disabled = false;
  }
});
