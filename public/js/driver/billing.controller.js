// ─── Billing Controller ────────────────────────────────────────────────────────
// Handles the Stripe billing setup / management flows:
//   • view-billing  — shown when subscription is not active
//   • view-verify-email — shown when email is not verified
//   • Account → Subscription card
//
// Depends on: utils.js (api, showToast), app.js (showView, doLogout, driverProfile)

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_LABELS = {
  trialing:   { label: 'Free Trial',      bg: 'rgba(0,194,212,0.15)',  color: '#00c2d4' },
  active:     { label: 'Active',          bg: 'rgba(39,192,131,0.15)', color: '#27c083' },
  past_due:   { label: 'Payment Due',     bg: 'rgba(240,90,91,0.15)',  color: '#f05a5b' },
  canceled:   { label: 'Canceled',        bg: 'rgba(122,138,181,0.2)', color: '#7a8ab5' },
  unpaid:     { label: 'Unpaid',          bg: 'rgba(240,90,91,0.15)',  color: '#f05a5b' },
  incomplete: { label: 'Incomplete',      bg: 'rgba(245,166,35,0.15)', color: '#f5a623' },
};

function renderSubscriptionBadge(status) {
  const badge = document.getElementById('acct-sub-status-badge');
  if (!badge) return;
  const cfg = STATUS_LABELS[status] || { label: status || 'Unknown', bg: 'rgba(122,138,181,0.2)', color: '#7a8ab5' };
  badge.textContent = cfg.label;
  badge.style.background = cfg.bg;
  badge.style.color       = cfg.color;
}

function renderTrialInfo(profile) {
  const el = document.getElementById('acct-sub-trial-info');
  if (!el) return;
  if (profile.subscription_status === 'trialing' && profile.trial_ends_at) {
    const end  = new Date(profile.trial_ends_at);
    const days = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    el.textContent = `Trial ends in ${days} day${days !== 1 ? 's' : ''} (${end.toLocaleDateString()})`;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

// ─── Billing button in Account tab ───────────────────────────────────────────
document.getElementById('btn-acct-billing').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = '…';
  try {
    const data = await api('/api/auth/driver/billing-portal', { method: 'POST' });
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not open billing portal', 'error');
    this.disabled  = false;
    this.textContent = 'Manage Billing';
  }
});

// Called from app.js when driverProfile loads
window.renderAccountSubscription = function (profile) {
  if (!profile) return;
  renderSubscriptionBadge(profile.subscription_status);
  renderTrialInfo(profile);
};

// ─── Persistent "add a card" dashboard banner ─────────────────────────────────
// Shown whenever the driver carries a card_required_by deadline (the grandfathered
// cardless cohort). It is NOT dismissible — it disappears only when the deadline
// is cleared server-side, which happens the moment a card is confirmed on file.
window.renderCardBanner = function (profile) {
  const banner = document.getElementById('dash-card-banner');
  if (!banner) return;

  if (!profile || !profile.card_required_by) {
    banner.style.display = 'none';
    return;
  }

  const textEl = document.getElementById('dash-card-banner-text');
  if (textEl) {
    const due  = new Date(profile.card_required_by);
    const days = Math.ceil((due - Date.now()) / 86400000);
    const by   = due.toLocaleDateString();
    if (days > 1) {
      textEl.textContent = `Your account has no payment method on file. Add a card within ${days} days (by ${by}) — after that your account will be deactivated.`;
    } else if (days === 1) {
      textEl.textContent = `Your account has no payment method on file. Add a card by tomorrow (${by}) — after that your account will be deactivated.`;
    } else if (days === 0) {
      textEl.textContent = `Last day — add a payment method today (${by}) to keep your account active.`;
    } else {
      textEl.textContent = `Your account has no payment method on file. Add a card now to keep it active.`;
    }
  }

  banner.style.display = 'block';
};

// ─── Scheduled-cancellation grace banner ──────────────────────────────────────
// Shown when the driver has canceled but is still inside the grace window: the
// subscription is live (status active/trialing) with a future
// subscription_cancel_at. Access continues; the banner counts down to the cutoff
// and offers a one-tap "keep my subscription" (removes the scheduled cancel, no
// new charge). Cleared server-side the moment the cancellation is undone.
window.renderCancelBanner = function (profile) {
  const banner = document.getElementById('dash-cancel-banner');
  if (!banner) return;

  // Only during the grace window: a future cancel date AND still-active access.
  // Once status flips to canceled the driver is on the lockout screen instead.
  const active = ['trialing', 'active'].includes(profile?.subscription_status);
  if (!profile || !profile.subscription_cancel_at || !active) {
    banner.style.display = 'none';
    return;
  }

  const textEl = document.getElementById('dash-cancel-banner-text');
  if (textEl) {
    const end  = new Date(profile.subscription_cancel_at);
    const days = Math.ceil((end - Date.now()) / 86400000);
    const on   = end.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    if (days > 1) {
      textEl.textContent = `Your access ends on ${on} (${days} days left). Keep your subscription to stay active — you won't be charged anything extra.`;
    } else if (days === 1) {
      textEl.textContent = `Your access ends tomorrow (${on}). Keep your subscription to stay active — you won't be charged anything extra.`;
    } else {
      textEl.textContent = `Your access ends today (${on}). Keep your subscription now to avoid losing access.`;
    }
  }

  banner.style.display = 'block';
};

// "Keep my subscription →" — removes the scheduled cancellation on the still-live
// subscription. No redirect, no charge; on success we hide the banner and patch
// local state so the UI updates instantly.
document.getElementById('btn-dash-resume-sub')?.addEventListener('click', async function () {
  this.disabled = true;
  this.innerHTML = '<span class="spinner"></span> Updating…';
  try {
    const data = await api('/api/auth/driver/resume-subscription', { method: 'POST' });
    if (typeof driverProfile !== 'undefined' && driverProfile) {
      driverProfile.subscription_cancel_at = null;
      if (data.subscription_status) driverProfile.subscription_status = data.subscription_status;
    }
    document.getElementById('dash-cancel-banner').style.display = 'none';
    showToast('✅ Your subscription will continue. Welcome back!', 'success');
  } catch (err) {
    showToast(err.message || 'Could not update your subscription. Please try again.', 'error');
    this.disabled  = false;
    this.textContent = 'Keep my subscription →';
  }
});

// "Add card →" button on the dashboard banner — same hosted Checkout as the
// trial button (self-heals grandfathered drivers: creates the customer + a
// subscription and collects the card in one step).
document.getElementById('btn-dash-add-card')?.addEventListener('click', async function () {
  this.disabled = true;
  this.innerHTML = '<span class="spinner"></span> Connecting…';
  try {
    const data = await api('/api/auth/driver/create-checkout', { method: 'POST' });
    // Already paid + live on Stripe (duplicate-checkout guard) — the banner
    // clears on the next profile refresh; nothing to collect.
    if (data.already_subscribed) {
      showToast('✅ Your subscription is already active — no card needed.', 'success');
      this.disabled    = false;
      this.textContent = 'Add card →';
      const banner = document.getElementById('dash-card-banner');
      if (banner) banner.style.display = 'none';
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start checkout. Please try again.', 'error');
    this.disabled    = false;
    this.textContent = 'Add card →';
  }
});

// ─── view-billing helpers ─────────────────────────────────────────────────────

/**
 * Configure the billing view for the current driver's subscription_status.
 * Must be called just before showView('view-billing').
 */
window.prepareBillingView = function (profile) {
  const title    = document.getElementById('billing-view-title');
  const subtitle = document.getElementById('billing-view-subtitle');
  const btnStart = document.getElementById('btn-start-billing');
  const btnP     = document.getElementById('billing-view-subtitle').parentElement;
  const manageSection = document.getElementById('billing-manage-section');

  const errEl = document.getElementById('billing-error');
  errEl.style.display = 'none';
  errEl.textContent   = '';

  // Stripe's reason for the last failed charge (cleared server-side the moment
  // a payment succeeds). Telling drivers WHY stops them retrying the same bad
  // card over and over.
  const declineEl = document.getElementById('billing-decline-reason');
  if (declineEl) {
    if (profile?.last_payment_error) {
      declineEl.textContent   = `⚠️ Last payment attempt failed — ${profile.last_payment_error}`;
      declineEl.style.display = 'block';
    } else {
      declineEl.style.display = 'none';
      declineEl.textContent   = '';
    }
  }

  // Fine print under the primary CTA. With the free trial off
  // (TRIAL_PERIOD_DAYS unset/0, the current default), every branch — new
  // signups included — is charged at Checkout, so the note always states an
  // immediate charge. (If the trial is re-enabled server-side, restore the
  // new-subscriber copy below to trial wording.)
  const ctaNote      = document.getElementById('billing-cta-note');
  const NEW_SUB_NOTE = "Card required — you'll be charged $16 today. Cancel any time.";

  // The pricing pill's suffix. With the trial off every branch charges
  // immediately, so all show "/ month"; the withTrial arg is kept for when the
  // trial is re-enabled (TRIAL_PERIOD_DAYS > 0).
  const priceSuffix = document.getElementById('billing-price-suffix');
  const setPriceSuffix = (withTrial) => {
    if (priceSuffix) priceSuffix.textContent = withTrial ? '/ month after trial' : '/ month';
  };

  const status = profile?.subscription_status;

  // Default the primary CTA to the standard new-subscription Checkout. The
  // past_due branch overrides this to the reactivate endpoint (which re-collects
  // a card and settles the open invoice without creating a second subscription).
  btnStart.dataset.endpoint = '/api/auth/driver/create-checkout';

  // Card-enforcement deactivation takes precedence over the generic past_due
  // copy: these drivers were deactivated for having no card on file, and they
  // reactivate by adding one (hosted Checkout via btn-start-billing), not via
  // the billing portal. They already used the system on a free ride, so
  // checkout charges them immediately (no fresh trial) — say so.
  if (profile?.card_required_by) {
    title.textContent    = 'Add a Card to Reactivate';
    subtitle.textContent = 'Your subscription is inactive because there is no card on file. Add a card to reactivate your account.';
    btnStart.textContent = 'Add Card →';
    btnStart.style.display   = '';
    manageSection.style.display = 'none';
    setPriceSuffix(false);
    if (ctaNote) { ctaNote.textContent = 'Your card will be charged today to reactivate your account. Cancel any time.'; ctaNote.style.display = ''; }
  } else if (status === 'past_due') {
    // Failed payment → locked out. Re-add a card in-app; the card is charged
    // immediately to settle the missed payment (reactivate endpoint), rather
    // than bouncing the driver to the Stripe portal and waiting on dunning.
    title.textContent    = 'Payment Required';
    subtitle.textContent = 'Your last payment failed and your account is paused. Add your card to settle the missed payment and restore access.';
    btnStart.textContent = 'Add Card & Pay Now →';
    btnStart.dataset.endpoint = '/api/auth/driver/reactivate-checkout';
    btnStart.style.display   = '';
    manageSection.style.display = 'none';
    setPriceSuffix(false);
    if (ctaNote) { ctaNote.textContent = 'Your card will be charged now to settle the missed payment. Cancel any time.'; ctaNote.style.display = ''; }
  } else if (status === 'canceled' || status === 'unpaid') {
    // Resubscribing drivers already used their trial — checkout charges the
    // card immediately (skipTrial server-side), so the fine print must not
    // promise a free trial.
    title.textContent    = 'Subscription Ended';
    subtitle.textContent = 'You do not have an active subscription. Add your card back to continue using SAN Queue.';
    btnStart.textContent = 'Resubscribe →';
    btnStart.style.display   = '';
    manageSection.style.display = 'none';
    setPriceSuffix(false);
    if (ctaNote) { ctaNote.textContent = 'Your card will be charged today to restart your subscription. Cancel any time.'; ctaNote.style.display = ''; }
  } else {
    title.textContent    = 'Start Your Subscription';
    subtitle.textContent = '$16 / month — cancel any time';
    btnStart.textContent = 'Subscribe →';
    btnStart.style.display   = '';
    manageSection.style.display = 'none';
    setPriceSuffix(false);
    if (ctaNote) { ctaNote.textContent = NEW_SUB_NOTE; ctaNote.style.display = ''; }
  }
};

// ─── Paywall self-heal ────────────────────────────────────────────────────────
// A driver who paid can still be looking at the paywall: in the installed PWA
// the Stripe redirect lands in an in-app browser (separate window — the PWA
// never navigates), and even in a normal tab the boot poll gives up after 8 s.
// So whenever the paywall is the active view and the app regains focus — or the
// driver taps the manual refresh button — verify against Stripe via the server
// and route straight to the dashboard the moment the subscription is live.

function billingViewActive() {
  return document.getElementById('view-billing')?.classList.contains('active');
}

let _paywallSyncBusy = false;
let _paywallSyncLast = 0;

/**
 * Verify the subscription server-side (Stripe truth) and re-route if it's live.
 * Auto-triggers are throttled to one attempt per 5 s; pass force=true (manual
 * refresh button) to bypass the throttle. Returns true when access was granted.
 */
async function syncPaywallStatus(force = false) {
  if (_paywallSyncBusy) return false;
  if (!force && Date.now() - _paywallSyncLast < 5000) return false;
  _paywallSyncBusy = true;
  _paywallSyncLast = Date.now();
  try {
    const sync = await api('/api/auth/driver/sync-subscription', { method: 'POST' });
    if (!['trialing', 'active'].includes(sync.subscription_status)) return false;
    const fresh = await api('/api/driver/profile');
    showToast('🎉 Subscription active — welcome to SAN Queue!', 'success');
    routeDriver(fresh);
    return true;
  } catch {
    return false; // network / not logged in — the paywall simply stays
  } finally {
    _paywallSyncBusy = false;
  }
}

// Re-check when the driver switches back to the app while parked on the paywall
// (the common return path after paying in the in-app/external browser).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && billingViewActive()) syncPaywallStatus();
});

// Manual escape hatch on the paywall: "Already paid? Refresh status"
document.getElementById('btn-billing-refresh')?.addEventListener('click', async function () {
  this.disabled = true;
  // innerHTML, not textContent — the label includes an inline SVG refresh icon
  const original = this.innerHTML;
  this.innerHTML = '<span class="spinner"></span> Checking…';
  const ok = await syncPaywallStatus(true);
  if (!ok) {
    showToast('No active subscription found yet. If you just paid, wait a few seconds and try again.', 'error');
    this.disabled  = false;
    this.innerHTML = original;
  }
});

// ─── Start billing / checkout ─────────────────────────────────────────────────
document.getElementById('btn-start-billing').addEventListener('click', async function () {
  const errEl = document.getElementById('billing-error');
  errEl.style.display = 'none';
  this.disabled = true;
  this.innerHTML = '<span class="spinner"></span> Connecting to Stripe…';

  // Endpoint depends on account state — past_due reactivates the existing
  // subscription; everyone else starts/restarts one. Set by prepareBillingView.
  const endpoint = this.dataset.endpoint || '/api/auth/driver/create-checkout';

  try {
    const data = await api(endpoint, { method: 'POST' });
    // Duplicate-checkout guard tripped server-side: they already paid and
    // Stripe holds a live subscription — let them straight in, no re-charge.
    if (data.already_subscribed) {
      const fresh = await api('/api/driver/profile');
      showToast('🎉 You already have an active subscription — welcome back!', 'success');
      routeDriver(fresh);
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    errEl.textContent   = err.message || 'Could not start checkout. Please try again.';
    errEl.style.display = 'block';
    this.disabled       = false;
    // Restore the state-correct button label (varies: trial / reactivate / etc.)
    if (typeof driverProfile !== 'undefined' && driverProfile && window.prepareBillingView) {
      window.prepareBillingView(driverProfile);
    } else {
      this.textContent = 'Subscribe →';
    }
  }
});

// ─── Manage billing (past_due) ────────────────────────────────────────────────
document.getElementById('btn-manage-billing').addEventListener('click', async function () {
  this.disabled = true;
  this.innerHTML = '<span class="spinner"></span> Opening portal…';
  try {
    const data = await api('/api/auth/driver/billing-portal', { method: 'POST' });
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not open billing portal', 'error');
    this.disabled  = false;
    this.textContent = 'Update Payment Method';
  }
});

// ─── bfcache restore — reset stuck Stripe-redirect buttons ──────────────────
// Each Stripe button (Manage Billing, Update Payment, Start Trial) flips to
// a "loading" state before redirecting via window.location.href. Stripe's
// "Back to SAN Queue" link does a fresh navigation (state resets naturally),
// but Stripe's "Close" button uses history.back(), which restores this page
// from the browser's back-forward cache with the disabled spinner state
// preserved. This handler detects bfcache restore (event.persisted === true)
// and reverts each button to its idle text.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;

  const resets = [
    { id: 'btn-acct-billing',   text: 'Manage Billing'        },
    { id: 'btn-manage-billing', text: 'Update Payment Method' },
    { id: 'btn-start-billing',  text: 'Subscribe →'           },
  ];
  for (const { id, text } of resets) {
    const btn = document.getElementById(id);
    if (btn && btn.disabled) {
      btn.disabled    = false;
      btn.textContent = text;
    }
  }

  // btn-start-billing's correct text varies by subscription state
  // ("Resubscribe →" for canceled/unpaid). Re-run prepareBillingView with
  // the cached profile so the label matches reality.
  if (typeof driverProfile !== 'undefined' && driverProfile && window.prepareBillingView) {
    window.prepareBillingView(driverProfile);
  }

  // Restored from bfcache onto the paywall (Stripe's "Close" uses
  // history.back()) — the driver may have just paid, so verify with Stripe.
  if (billingViewActive()) syncPaywallStatus();
});

// ─── view-verify-email helpers ────────────────────────────────────────────────
window.prepareVerifyEmailView = function (profile) {
  const addrEl = document.getElementById('verify-email-addr');
  if (addrEl) addrEl.textContent = profile?.email || 'your email address';
};

document.getElementById('btn-resend-verify-email').addEventListener('click', async function () {
  this.disabled    = true;
  this.textContent = 'Sending…';
  try {
    await api('/api/auth/driver/resend-verification', { method: 'POST' });
    showToast('Verification email sent — check your inbox!', 'success');
    this.textContent = '✓ Sent';
    setTimeout(() => {
      this.disabled    = false;
      this.textContent = 'Resend verification email';
    }, 5000);
  } catch (err) {
    showToast(err.message, 'error');
    this.disabled    = false;
    this.textContent = 'Resend verification email';
  }
});
