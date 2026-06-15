// ─── Driver Messages Controller ───────────────────────────────────────────────
// In-app inbox for admin broadcasts: bell + unread badge, a sticky banner for
// the newest unread message, and an inbox panel.
//
// Behavior (per product spec):
//   • Bell badge  = unread count (source of truth).
//   • Banner      = newest unread message; stays until ✕'d. Closing the banner
//                   does NOT mark it read — it only hides the banner (remembered
//                   so it doesn't re-show for that message).
//   • Open inbox  = shows messages, unread highlighted. Unread clears when the
//                   driver taps a message (marks that one) or taps "Mark all as
//                   read". The badge reflects the count at all times.
//
// Real-time: the service worker postMessages this tab when a push arrives
// ('admin_message') or a notification is tapped ('open_message'). We also refresh
// on app boot and when the window regains focus (covers drivers without push).
//
// Depends on: utils.js (api, esc, showToast).

const MSG_DISMISSED_KEY = 'msgBannerDismissed'; // localStorage: ids whose banner was ✕'d

let msgItems        = [];     // [{ id, title, body, url, read_at, created_at }]
let msgUnread       = 0;
let msgBooted       = false;
let msgPollTimer    = null;

function $msg(id) { return document.getElementById(id); }

// ─── Dismissed-banner persistence ─────────────────────────────────────────────
function getDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(MSG_DISMISSED_KEY) || '[]')); }
  catch { return new Set(); }
}
function addDismissed(id) {
  const set = getDismissed();
  set.add(id);
  // Keep the list bounded — only the most recent 100 ids matter.
  const arr = Array.from(set).slice(-100);
  localStorage.setItem(MSG_DISMISSED_KEY, JSON.stringify(arr));
}

// ─── Badge ─────────────────────────────────────────────────────────────────────
function renderBadge() {
  document.querySelectorAll('.notif-badge').forEach((el) => {
    if (msgUnread > 0) {
      el.textContent   = msgUnread > 9 ? '9+' : String(msgUnread);
      el.style.display = 'inline-block';
    } else {
      el.style.display = 'none';
    }
  });
}

// ─── Banner ────────────────────────────────────────────────────────────────────
function renderBanner() {
  const banner = $msg('msg-banner');
  if (!banner) return;

  // Newest unread message that the driver hasn't dismissed the banner for.
  const dismissed = getDismissed();
  const newest = msgItems.find((m) => !m.read_at && !dismissed.has(m.id));

  if (!newest) {
    banner.classList.remove('show');
    return;
  }

  $msg('msg-banner-title').textContent = newest.title;
  $msg('msg-banner-body').textContent  = newest.body;
  banner.dataset.messageId = newest.id;
  banner.classList.add('show');
}

// ─── Inbox rendering ───────────────────────────────────────────────────────────
function fmtMsgTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function renderInbox() {
  const list = $msg('msg-inbox-list');
  if (!list) return;

  if (!msgItems.length) {
    list.innerHTML = '<div class="msg-empty">No messages yet</div>';
    return;
  }

  list.innerHTML = msgItems.map((m) => {
    const unread = !m.read_at;
    return `
      <div class="msg-item ${unread ? 'unread' : ''}" data-id="${esc(m.id)}" ${m.url ? `data-url="${esc(m.url)}"` : ''}>
        <div class="row">
          ${unread ? '<span class="dot"></span>' : ''}
          <span class="title">${esc(m.title)}</span>
          <span class="time">${esc(fmtMsgTime(m.created_at))}</span>
        </div>
        <div class="body">${esc(m.body)}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.msg-item').forEach((el) => {
    el.addEventListener('click', () => {
      markOneRead(el.dataset.id);
      const url = el.dataset.url;
      if (url) {
        // Internal links navigate in-app; external open in a new tab.
        if (url.startsWith('/')) window.location.href = url;
        else window.open(url, '_blank', 'noopener');
      }
    });
  });
}

function updateMarkAllBtn() {
  const btn = $msg('btn-msg-mark-all');
  if (btn) btn.style.display = msgUnread > 0 ? 'inline-block' : 'none';
}

// ─── Mark read ─────────────────────────────────────────────────────────────────
async function markOneRead(idStr) {
  const item = msgItems.find((m) => String(m.id) === String(idStr));
  if (!item || item.read_at) return;
  // Optimistic: update UI first, then persist (best-effort).
  item.read_at = new Date().toISOString();
  msgUnread = Math.max(0, msgUnread - 1);
  renderBadge(); renderBanner(); renderInbox(); updateMarkAllBtn();
  try { await api(`/api/driver/messages/${idStr}/read`, { method: 'POST' }); } catch { /* best-effort */ }
}

async function markAllRead() {
  if (msgUnread === 0) return;
  msgItems = msgItems.map((m) => ({ ...m, read_at: m.read_at || new Date().toISOString() }));
  msgUnread = 0;
  renderBadge(); renderBanner(); renderInbox(); updateMarkAllBtn();
  try { await api('/api/driver/messages/read-all', { method: 'POST' }); } catch { /* best-effort */ }
}

// ─── Data fetch ────────────────────────────────────────────────────────────────
async function refreshMessages() {
  try {
    const data = await api('/api/driver/messages?limit=50');
    msgItems  = data.messages || [];
    msgUnread = data.unread || 0;
    renderBadge();
    renderBanner();
    // If the inbox is open, re-render it live (e.g. a push arrived while open).
    if ($msg('msg-inbox-overlay')?.classList.contains('show')) { renderInbox(); updateMarkAllBtn(); }
  } catch {
    // Endpoint not reachable / not logged in — leave UI as-is.
  }
}

// ─── Open / close inbox ────────────────────────────────────────────────────────
async function openInbox() {
  // Make sure we have the latest before rendering.
  await refreshMessages();

  renderInbox();
  updateMarkAllBtn();
  $msg('msg-inbox-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeInbox() {
  $msg('msg-inbox-overlay')?.classList.remove('show');
  document.body.style.overflow = '';
}

// ─── Boot + wiring ─────────────────────────────────────────────────────────────
function initMessages() {
  // Wire once, even though initMessages() is called on every dashboard mount.
  if (!msgBooted) {
    msgBooted = true;

    // Bell (one per main-view header) → open inbox.
    document.querySelectorAll('.notif-bell').forEach((bell) => {
      bell.addEventListener('click', openInbox);
    });

    // Banner: tap body → open inbox; ✕ → dismiss banner only (stays unread).
    $msg('msg-banner-content')?.addEventListener('click', openInbox);
    $msg('msg-banner-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number($msg('msg-banner').dataset.messageId);
      if (id) addDismissed(id);
      $msg('msg-banner').classList.remove('show');
    });

    // Inbox close + mark all read.
    $msg('btn-msg-inbox-close')?.addEventListener('click', closeInbox);
    $msg('btn-msg-mark-all')?.addEventListener('click', markAllRead);
    $msg('msg-inbox-overlay')?.addEventListener('click', (e) => {
      if (e.target === $msg('msg-inbox-overlay')) closeInbox();
    });

    // Service worker → live updates.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const t = event.data?.type;
        if (t === 'admin_message') {
          // New push landed while app open — refresh badge/banner immediately.
          refreshMessages();
        } else if (t === 'open_message') {
          // Driver tapped a notification — open the inbox and mark that one read.
          openInbox();
          if (event.data.messageId != null) markOneRead(event.data.messageId);
        }
      });
    }

    // Refresh when the app regains focus (covers drivers without push enabled).
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshMessages();
    });

    // Light foreground poll fallback (every 60s) for the no-push case.
    if (!msgPollTimer) {
      msgPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshMessages();
      }, 60000);
    }
  }

  refreshMessages();
}

// Expose for app.js (called from showView when the dashboard mounts).
window.initMessages = initMessages;
