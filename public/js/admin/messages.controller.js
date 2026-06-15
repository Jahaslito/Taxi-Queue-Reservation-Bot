// ─── Admin Messages Controller ────────────────────────────────────────────────
// Compose + send broadcasts (blast or targeted), plus sent history.
// Depends on: utils.js (api, esc, showToast). Wired by app.js via onMessagesPageShow().

// ─── State ────────────────────────────────────────────────────────────────────
let msgDrivers       = [];          // [{ id, name, vehicle_number }]
const msgSelectedIds = new Set();   // selected driver ids when targeting
let msgDriversLoaded = false;
let msgSending       = false;

function $m(id) { return document.getElementById(id); }

// ─── Page show hook ─────────────────────────────────────────────────────────
function onMessagesPageShow() {
  loadMessageHistory();
  // Lazy-load the driver list once; refreshed when the picker is opened.
  if (!msgDriversLoaded) loadMessageDrivers();
}

// ─── Targeting: All vs Selected ───────────────────────────────────────────────
function currentTarget() {
  const checked = document.querySelector('input[name="msg-target"]:checked');
  return checked ? checked.value : 'all';
}

function onTargetChange() {
  const picker = $m('msg-driver-picker');
  picker.style.display = currentTarget() === 'selected' ? 'block' : 'none';
}

// ─── Driver picker ────────────────────────────────────────────────────────────
// Server-side search (active drivers only) so the picker scales past the 100-row
// page cap on the drivers endpoint. The selected Set persists across searches —
// a driver scrolled out by a filter stays selected and is still sent.
async function loadMessageDrivers(search = '') {
  const list = $m('msg-driver-list');
  list.innerHTML = '<div style="color:var(--muted2);text-align:center;padding:18px;">Loading drivers…</div>';
  try {
    let url = '/api/admin/drivers?active=true&limit=100';
    if (search) url += `&search=${encodeURIComponent(search)}`;
    const data = await api(url);
    if (!data) return; // 401 handled by api()
    msgDrivers = data.drivers || [];
    msgDriversLoaded = true;
    renderDriverList();
  } catch (err) {
    list.innerHTML = `<div style="color:var(--red);text-align:center;padding:18px;">${esc(err.message)}</div>`;
  }
}

function renderDriverList() {
  const list = $m('msg-driver-list');

  if (!msgDrivers.length) {
    list.innerHTML = '<div style="color:var(--muted2);text-align:center;padding:18px;">No drivers match</div>';
    return;
  }

  list.innerHTML = msgDrivers.map(d => `
    <label class="msg-driver-item">
      <input type="checkbox" value="${esc(d.id)}" ${msgSelectedIds.has(d.id) ? 'checked' : ''} />
      <span>${esc(d.name || 'Unnamed')}</span>
      <span class="sub">#${esc(d.vehicle_number || '—')}</span>
    </label>`).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.value);
      if (cb.checked) msgSelectedIds.add(id); else msgSelectedIds.delete(id);
      updateSelectedCount();
    });
  });

  updateSelectedCount();
}

function updateSelectedCount() {
  $m('msg-selected-count').textContent = `${msgSelectedIds.size} selected`;
}

// ─── Char counters ────────────────────────────────────────────────────────────
function wireCounter(inputId, countId) {
  const input = $m(inputId);
  const count = $m(countId);
  const sync = () => { count.textContent = String(input.value.length); };
  input.addEventListener('input', sync);
  sync();
}

// ─── Themed confirm modal (replaces native confirm) ──────────────────────────
function confirmSend(message) {
  return new Promise((resolve) => {
    const overlay = $m('msg-confirm-modal');
    const okBtn   = $m('msg-confirm-ok');
    const cancel  = $m('msg-confirm-cancel');
    const body    = $m('msg-confirm-body');
    if (!overlay || !okBtn || !cancel) { resolve(window.confirm(message)); return; }

    body.textContent = message;

    const close = (val) => {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk       = () => close(true);
    const onCancel   = () => close(false);
    const onBackdrop = (e) => { if (e.target === overlay) close(false); };
    const onKey      = (e) => { if (e.key === 'Escape') close(false); };

    okBtn.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    overlay.classList.add('open');
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendMessage() {
  if (msgSending) return;

  const title   = $m('msg-title').value.trim();
  const body    = $m('msg-body').value.trim();
  const sendSms = $m('msg-send-sms').checked;
  const target  = currentTarget();

  if (!title)        { showToast('Add a title', 'error'); return; }
  if (!body)         { showToast('Add a message', 'error'); return; }

  let driverIds = [];
  if (target === 'selected') {
    driverIds = Array.from(msgSelectedIds);
    if (!driverIds.length) { showToast('Select at least one driver, or choose "All"', 'error'); return; }
  }

  const audience = target === 'all' ? 'all active drivers' : `${driverIds.length} selected driver(s)`;
  const smsNote  = sendSms ? ' via push + SMS' : ' via push';
  const ok = await confirmSend(`Send “${title}” to ${audience}${smsNote}?`);
  if (!ok) return;

  msgSending = true;
  const btn = $m('btn-send-message');
  const status = $m('msg-send-status');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.textContent = '';

  try {
    const result = await api('/api/admin/messages/broadcast', {
      method: 'POST',
      body: JSON.stringify({ title, body, driverIds, sendSms }),
    });
    if (!result) return; // 401 handled

    const p = result.push || {};
    const s = result.sms  || {};
    let summary = `Sent to ${result.recipients} driver(s) · push ${p.delivered}/${p.targeted}`;
    if (sendSms) summary += ` · SMS ${s.sent}/${s.targeted}`;
    showToast(summary, 'success', 5000);
    status.textContent = summary;

    // Reset composer
    $m('msg-title').value = '';
    $m('msg-body').value  = '';
    $m('msg-title-count').textContent = '0';
    $m('msg-body-count').textContent  = '0';
    msgSelectedIds.clear();
    updateSelectedCount();

    loadMessageHistory(1);
  } catch (err) {
    showToast(err.message || 'Could not send message', 'error');
    status.textContent = '';
  } finally {
    msgSending = false;
    btn.disabled = false;
    btn.textContent = 'Send message';
  }
}

// ─── Sent history ─────────────────────────────────────────────────────────────
function fmtMsgTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });
}

// ─── Sent-history pagination ───────────────────────────────────────────────────
let msgHistPage = 1;
const MSG_HIST_PER = 10;

function setMsgHistoryPagination(total) {
  const bar     = $m('msg-history-pagination');
  const info    = $m('msg-history-info');
  const label   = $m('msg-history-label');
  const prevBtn = $m('msg-history-prev');
  const nextBtn = $m('msg-history-next');
  const totalPages = Math.ceil(total / MSG_HIST_PER) || 1;
  const from = Math.min((msgHistPage - 1) * MSG_HIST_PER + 1, total);
  const to   = Math.min(msgHistPage * MSG_HIST_PER, total);

  bar.style.display = total > 0 ? 'flex' : 'none';
  info.textContent  = total > 0 ? `Showing ${from}–${to} of ${total} message${total !== 1 ? 's' : ''}` : '';
  label.textContent = `Page ${msgHistPage} of ${totalPages}`;
  prevBtn.disabled  = msgHistPage <= 1;
  nextBtn.disabled  = msgHistPage >= totalPages;
}

async function loadMessageHistory(page) {
  if (page !== undefined) msgHistPage = page;
  const offset = (msgHistPage - 1) * MSG_HIST_PER;
  const container = $m('msg-history');
  try {
    const data = await api(`/api/admin/messages?limit=${MSG_HIST_PER}&offset=${offset}`);
    if (!data) return;

    if (!data.messages.length) {
      container.innerHTML = '<div style="color:var(--muted2);text-align:center;padding:18px;">No messages sent yet</div>';
      setMsgHistoryPagination(0);
      return;
    }

    container.innerHTML = data.messages.map(m => {
      const reads      = Number(m.read_count) || 0;
      const recipients = Number(m.recipient_count) || 0;
      const target     = m.target_type === 'all' ? 'All drivers' : 'Selected';
      const smsBit     = m.send_sms ? ` · SMS ${m.sms_sent}/${m.sms_targeted}` : '';
      return `
        <div class="msg-history-item">
          <div class="title">📣 ${esc(m.title)}</div>
          <div class="body">${esc(m.body)}</div>
          <div class="meta">
            <span>${fmtMsgTime(m.created_at)}</span>
            <span>${esc(target)} · ${recipients} recipient(s)</span>
            <span>push ${esc(m.push_delivered)}/${esc(m.push_targeted)}${smsBit}</span>
            <span>read ${reads}/${recipients}</span>
          </div>
        </div>`;
    }).join('');

    setMsgHistoryPagination(data.total || 0);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);text-align:center;padding:18px;">${esc(err.message)}</div>`;
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
document.querySelectorAll('input[name="msg-target"]').forEach(r => {
  r.addEventListener('change', onTargetChange);
});

let msgSearchTimeout;
$m('msg-driver-search')?.addEventListener('input', (e) => {
  clearTimeout(msgSearchTimeout);
  msgSearchTimeout = setTimeout(() => loadMessageDrivers(e.target.value.trim()), 250);
});

$m('btn-send-message')?.addEventListener('click', sendMessage);

// Sent-history pagination
$m('msg-history-prev')?.addEventListener('click', () => { if (msgHistPage > 1) loadMessageHistory(msgHistPage - 1); });
$m('msg-history-next')?.addEventListener('click', () => loadMessageHistory(msgHistPage + 1));

wireCounter('msg-title', 'msg-title-count');
wireCounter('msg-body',  'msg-body-count');

// Expose the page-show hook for app.js
window.onMessagesPageShow = onMessagesPageShow;
