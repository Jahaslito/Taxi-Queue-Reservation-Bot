// ─── Admin Insurance Controller ───────────────────────────────────────────────
// Handles the Insurance page: overview dashboard (policy header, stat cards,
// cumulative-growth SVG chart, fleet-by-make), plus the Vehicles / Drivers /
// Claims / Endorsements / Reconciliation tabs. Read-only (Phase 1) except the
// audited "reveal DL" action. Depends on utils.js (api, esc, showToast).

const INS_PER = 50;
const insState = { veh: { page: 1 }, drv: { page: 1 }, clm: { page: 1 }, end: { page: 1 }, doc: { page: 1 } };
let insWired = false;

// ─── Entry point (called by showPage) ────────────────────────────────────────
function loadInsurance() {
  if (!insWired) { wireInsurance(); insWired = true; }
  const active = document.querySelector('#ins-tabs .ins-tab.active')?.dataset.tab || 'overview';
  loadInsOverview();          // stat cards stay fresh regardless of active tab
  if (active !== 'overview') loadInsTab(active);
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function showInsTab(tab) {
  document.querySelectorAll('#ins-tabs .ins-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#page-insurance .ins-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`ins-panel-${tab}`)?.classList.add('active');
  loadInsTab(tab);
}

function loadInsTab(tab) {
  if (tab === 'overview')       loadInsOverview();
  if (tab === 'vehicles')       loadInsVehicles(1);
  if (tab === 'drivers')        loadInsDrivers(1);
  if (tab === 'claims')         loadInsClaims(1);
  if (tab === 'endorsements')   loadInsEndorsements(1);
  if (tab === 'reconciliation') loadInsReconciliation();
  if (tab === 'documents')      loadInsDocuments();
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadInsOverview() {
  try {
    const data = await api('/api/admin/insurance/overview');
    if (!data) return;

    const card = document.getElementById('ins-policy-card');
    if (!data.imported) {
      card.innerHTML = '<div class="pc-item"><div class="l">No policy imported</div><div class="v" style="font-size:14px;color:var(--muted2);">Run <span class="mono">node scripts/import-insurance.js</span> to load the roster.</div></div>';
      ['ins-stat-vehicles', 'ins-stat-drivers', 'ins-stat-flags', 'ins-stat-claims'].forEach(id => { document.getElementById(id).textContent = '0'; });
      document.getElementById('ins-growth-chart').textContent = 'No data';
      document.getElementById('ins-make-list').textContent = 'No data';
      return;
    }

    const p = data.policy;
    const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
    card.innerHTML = `
      <div class="pc-item"><div class="l">Carrier</div><div class="v">${esc(p.carrier || '—')}</div></div>
      <div class="pc-item"><div class="l">Policy #</div><div class="v mono">${esc(p.policyNumber || '—')}</div></div>
      <div class="pc-item"><div class="l">Effective</div><div class="v">${esc(p.effectiveDate || '—')}</div></div>
      <div class="pc-item"><div class="l">Premium / Vehicle</div><div class="v">${money(p.premiumPerVehicle)}<span style="font-size:12px;color:var(--muted2);font-weight:400;"> / yr</span></div></div>`;

    document.getElementById('ins-stat-vehicles').textContent = data.totals.vehiclesOnPolicy;
    document.getElementById('ins-stat-premium').textContent  = `${money(data.premium.annualTotal)} / yr · ${money(data.premium.monthlyRunRate)} / mo`;
    document.getElementById('ins-stat-drivers').textContent  = data.totals.drivers;
    document.getElementById('ins-stat-companies').textContent = `${data.appLinks.linked} linked to app`;
    document.getElementById('ins-stat-flags').textContent    = data.compliance.needsMedical + data.compliance.noDriver;
    document.getElementById('ins-stat-flags-sub').textContent = `${data.compliance.needsMedical} needs-medical · ${data.compliance.noDriver} no-driver`;
    document.getElementById('ins-stat-claims').textContent   = data.totals.claims;

    renderGrowthChart(data.growth);
    renderFleetByMake(data.fleetByMake);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Inline-SVG line chart — zero dependencies, themes via CSS vars.
function renderGrowthChart(series) {
  const el = document.getElementById('ins-growth-chart');
  if (!series || !series.length) { el.textContent = 'No data'; return; }
  const W = 560, H = 160, pad = 30;
  const n = series.length;
  const max = Math.max(...series.map(s => s.count), 1);
  const px = (i) => pad + (n <= 1 ? (W - 2 * pad) / 2 : i * (W - 2 * pad) / (n - 1));
  const py = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = series.map((s, i) => `${px(i).toFixed(1)},${py(s.count).toFixed(1)}`).join(' ');
  const dots = series.map((s, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(s.count).toFixed(1)}" r="3" fill="var(--teal)"><title>${esc(s.month)}: ${s.count}</title></circle>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cumulative fleet growth">
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--border,rgba(255,255,255,0.1))"/>
      <text x="${pad}" y="16" fill="var(--muted2)" font-size="11">${max} vehicles</text>
      <polyline points="${pts}" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linejoin="round"/>
      ${dots}
      <text x="${pad}" y="${H - 8}" fill="var(--muted2)" font-size="11">${esc(series[0].month)}</text>
      <text x="${W - pad}" y="${H - 8}" fill="var(--muted2)" font-size="11" text-anchor="end">${esc(series[n - 1].month)}</text>
    </svg>`;
}

function renderFleetByMake(rows) {
  const el = document.getElementById('ins-make-list');
  if (!rows || !rows.length) { el.textContent = 'No data'; return; }
  const max = Math.max(...rows.map(r => r.count), 1);
  el.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0;">
      <div style="width:100px;font-size:13px;">${esc(r.make)}</div>
      <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:4px;height:16px;overflow:hidden;">
        <div style="width:${(r.count / max * 100).toFixed(1)}%;height:100%;background:var(--teal);opacity:0.75;"></div>
      </div>
      <div style="width:36px;text-align:right;font-size:13px;color:var(--muted2);">${r.count}</div>
    </div>`).join('');
}

// ─── Vehicles ─────────────────────────────────────────────────────────────────
async function loadInsVehicles(page) {
  if (page) insState.veh.page = page;
  const tbody = document.getElementById('ins-veh-body');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  const search = encodeURIComponent(document.getElementById('ins-veh-search').value || '');
  const status = document.getElementById('ins-veh-status').value || '';
  const statusParam = status ? `&status=${status}` : '';   // omit when "All" — empty fails validation
  const offset = (insState.veh.page - 1) * INS_PER;
  try {
    const data = await api(`/api/admin/insurance/vehicles?search=${search}${statusParam}&limit=${INS_PER}&offset=${offset}`);
    if (!data) return;
    if (!data.vehicles.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:32px;">No vehicles found</td></tr>'; insPager('veh', 0); return; }
    tbody.innerHTML = data.vehicles.map(v => `
      <tr>
        <td><span class="mono">${esc(v.cab_number || '—')}</span></td>
        <td>${esc(v.company || '—')}</td>
        <td style="font-size:13px;">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || '—')}</td>
        <td><span class="mono" style="font-size:12px;">${esc(v.vin || '—')}</span></td>
        <td style="font-size:13px;color:var(--muted2);">${esc(v.on_policy_date || '—')}</td>
        <td>${v.on_policy ? '<span class="badge success"><span class="badge-dot"></span>On</span>' : '<span class="badge inactive">Off</span>'}</td>
        <td style="font-size:13px;">${v.driver_name ? esc(v.driver_name) : '<span style="color:var(--muted2);">—</span>'}</td>
      </tr>`).join('');
    insPager('veh', data.total);
  } catch (err) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`; }
}

// ─── Drivers (DL masked, audited reveal) ──────────────────────────────────────
async function loadInsDrivers(page) {
  if (page) insState.drv.page = page;
  const tbody = document.getElementById('ins-drv-body');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  const search = encodeURIComponent(document.getElementById('ins-drv-search').value || '');
  const flag = document.getElementById('ins-drv-flag').value || '';
  const flagParam = flag ? `&${flag}=true` : '';
  const offset = (insState.drv.page - 1) * INS_PER;
  try {
    const data = await api(`/api/admin/insurance/drivers?search=${search}${flagParam}&limit=${INS_PER}&offset=${offset}`);
    if (!data) return;
    if (!data.drivers.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted2);padding:32px;">No drivers found</td></tr>'; insPager('drv', 0); return; }
    tbody.innerHTML = data.drivers.map(d => {
      const name = [d.first_name, d.last_name].filter(Boolean).join(' ') || '—';
      const dlCell = d.has_dl
        ? `<button class="btn btn-ghost btn-sm" data-action="reveal-dl" data-entity="drivers" data-id="${Number(d.id)}" title="Reveal full DL — this access is logged"><span class="mono">${esc(d.dl_masked)}</span> 👁</button>`
        : '<span style="color:var(--muted2);">—</span>';
      const dobCell = d.dob ? `${esc(d.dob)}${d.age != null ? ` <span style="color:var(--muted2);">(${d.age})</span>` : ''}` : '<span style="color:var(--muted2);">—</span>';
      const flags = [];
      if (d.needs_medical)      flags.push('<span class="badge pending">⚕️ Medical</span>');
      if (d.no_driver_assigned) flags.push('<span class="badge inactive">No driver</span>');
      return `
        <tr>
          <td><span class="mono">${esc(d.cab_number || '—')}</span></td>
          <td style="font-weight:600;">${esc(name)}</td>
          <td style="font-size:13px;color:var(--muted2);">${esc(d.company || '—')}</td>
          <td>${dlCell}</td>
          <td style="font-size:13px;">${dobCell}</td>
          <td>${flags.join(' ') || '<span style="color:var(--muted2);">—</span>'}</td>
          <td style="text-align:center;">${d.claim_count ? `<span class="badge failed">${d.claim_count}</span>` : '<span style="color:var(--muted2);">0</span>'}</td>
        </tr>`;
    }).join('');
    insPager('drv', data.total);
  } catch (err) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`; }
}

// ─── Claims ─────────────────────────────────────────────────────────────────
async function loadInsClaims(page) {
  if (page) insState.clm.page = page;
  const tbody = document.getElementById('ins-clm-body');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  const offset = (insState.clm.page - 1) * INS_PER;
  try {
    const data = await api(`/api/admin/insurance/claims?limit=${INS_PER}&offset=${offset}`);
    if (!data) return;
    if (!data.claims.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted2);padding:32px;">No claims on file</td></tr>'; insPager('clm', 0); return; }
    tbody.innerHTML = data.claims.map(c => {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
      return `
        <tr>
          <td style="font-size:13px;">${esc(c.date_of_loss || '—')}</td>
          <td><span class="mono">${esc(c.cab_number || '—')}</span></td>
          <td>${esc(name)}</td>
          <td><span class="mono" style="font-size:12px;">${esc(c.claim_number || '—')}</span></td>
          <td style="font-size:13px;color:var(--muted2);">${esc(c.description || '')}</td>
        </tr>`;
    }).join('');
    insPager('clm', data.total);
  } catch (err) { tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`; }
}

// ─── Endorsements (DL masked, audited reveal) ─────────────────────────────────
async function loadInsEndorsements(page) {
  if (page) insState.end.page = page;
  const tbody = document.getElementById('ins-end-body');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  const search = encodeURIComponent(document.getElementById('ins-end-search').value || '');
  const offset = (insState.end.page - 1) * INS_PER;
  try {
    const data = await api(`/api/admin/insurance/endorsements?search=${search}&limit=${INS_PER}&offset=${offset}`);
    if (!data) return;
    if (!data.endorsements.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted2);padding:32px;">No endorsements found</td></tr>'; insPager('end', 0); return; }
    tbody.innerHTML = data.endorsements.map(e => {
      const name = [e.first_name, e.last_name].filter(Boolean).join(' ') || '—';
      const dlCell = e.has_dl
        ? `<button class="btn btn-ghost btn-sm" data-action="reveal-dl" data-entity="endorsements" data-id="${Number(e.id)}" title="Reveal full DL — this access is logged"><span class="mono">${esc(e.dl_masked)}</span> 👁</button>`
        : '<span style="color:var(--muted2);">—</span>';
      return `
        <tr>
          <td><span class="mono">${esc(e.cab_number || '—')}</span></td>
          <td style="font-weight:600;">${esc(name)}</td>
          <td style="font-size:13px;color:var(--muted2);">${esc(e.company || '—')}</td>
          <td>${dlCell}</td>
          <td style="font-size:13px;">${esc(e.endorsement_text || '—')}</td>
        </tr>`;
    }).join('');
    insPager('end', data.total);
  } catch (err) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`; }
}

// ─── Reconciliation ───────────────────────────────────────────────────────────
async function loadInsReconciliation() {
  const upsellBody = document.getElementById('ins-rec-upsell-body');
  const gapBody    = document.getElementById('ins-rec-gap-body');
  upsellBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  gapBody.innerHTML    = '<tr><td colspan="3" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  try {
    const data = await api('/api/admin/insurance/reconciliation');
    if (!data) return;
    document.getElementById('ins-rec-upsell-count').textContent = `(${data.summary.insuredNotInApp})`;
    document.getElementById('ins-rec-gap-count').textContent    = `(${data.summary.appNotInsured})`;

    upsellBody.innerHTML = data.insuredNotInApp.length
      ? data.insuredNotInApp.map(v => `
          <tr>
            <td><span class="mono">${esc(v.cab_number || '—')}</span></td>
            <td>${esc(v.company || '—')}</td>
            <td style="font-size:13px;">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || '—')}</td>
            <td><span class="mono" style="font-size:12px;">${esc(v.vin || '—')}</span></td>
          </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--muted2);padding:24px;">Every on-policy vehicle is an app subscriber 🎉</td></tr>';

    gapBody.innerHTML = data.appNotInsured.length
      ? data.appNotInsured.map(d => `
          <tr>
            <td><span class="mono">${esc(d.vehicle_number || '—')}</span></td>
            <td style="font-weight:600;">${esc(d.name || '—')}</td>
            <td style="font-size:13px;color:var(--muted2);">${d.email ? esc(d.email) : '—'}</td>
          </tr>`).join('')
      : '<tr><td colspan="3" style="text-align:center;color:var(--muted2);padding:24px;">Every active app driver is on the policy ✓</td></tr>';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Documents (upload / list / download / preview / delete) ──────────────────
let insSelectedFiles = [];

function insFmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function insDocIcon(mime) {
  if (!mime) return '📄';
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('word')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel') || mime === 'text/csv') return '📊';
  return '📄';
}
function insFmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadInsDocuments(page) {
  if (page) insState.doc.page = page;
  const tbody = document.getElementById('ins-doc-body');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;"><span class="spinner"></span></td></tr>';
  const rawSearch = (document.getElementById('ins-doc-search')?.value || '').trim();
  const search    = encodeURIComponent(rawSearch);
  const offset    = (insState.doc.page - 1) * INS_PER;
  try {
    const data = await api(`/api/admin/insurance/documents?search=${search}&limit=${INS_PER}&offset=${offset}`);
    if (!data) return;
    document.getElementById('ins-doc-count').textContent = data.total ? `(${data.total})` : '';
    if (!data.documents.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted2);padding:32px;">${rawSearch ? 'No documents match your search' : 'No documents uploaded yet'}</td></tr>`;
      insPager('doc', 0);
      return;
    }
    tbody.innerHTML = data.documents.map(d => {
      const previewBtn = d.previewable
        ? `<button class="btn btn-ghost btn-sm" data-action="doc-preview" data-id="${Number(d.id)}" data-name="${esc(d.original_name)}">👁 Preview</button>`
        : '';
      return `
        <tr>
          <td style="font-weight:600;">${insDocIcon(d.mime_type)} ${esc(d.original_name)}${d.description ? `<div style="font-size:12px;color:var(--muted2);font-weight:400;">${esc(d.description)}</div>` : ''}</td>
          <td><span class="mono">${esc(d.cab_number || '—')}</span></td>
          <td style="font-size:12px;color:var(--muted2);">${esc((d.mime_type || '—').split('/').pop())}</td>
          <td style="font-size:13px;color:var(--muted2);">${insFmtBytes(d.size_bytes)}</td>
          <td style="font-size:13px;color:var(--muted2);">${insFmtDate(d.created_at)}</td>
          <td>
            <div class="doc-actions">
              ${previewBtn}
              <button class="btn btn-ghost btn-sm"  data-action="doc-download" data-id="${Number(d.id)}">⬇ Download</button>
              <button class="btn btn-danger btn-sm" data-action="doc-delete"   data-id="${Number(d.id)}" data-name="${esc(d.original_name)}">🗑 Delete</button>
            </div>
          </td>
        </tr>`;
    }).join('');
    insPager('doc', data.total);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);text-align:center;padding:24px;">${esc(err.message)}</td></tr>`;
  }
}

function insSetChosen(files) {
  insSelectedFiles = Array.from(files || []);
  const el  = document.getElementById('ins-file-chosen');
  const btn = document.getElementById('ins-upload-btn');
  if (!insSelectedFiles.length) { el.innerHTML = ''; btn.classList.add('is-inactive'); return; }
  // One row per file with a MANDATORY cab-number input. Upload stays disabled
  // until every file has a cab number (enforced again server-side).
  el.innerHTML = `
    <div class="ins-upload-list">
      <div class="ins-upload-hint">Enter the cab number(s) each document belongs to — one, or several comma-separated (e.g. <span class="mono">48, 156, 4322</span>). Required for every file:</div>
      ${insSelectedFiles.map((f, i) => `
        <div class="ins-upload-row">
          <span class="ins-upload-file" title="${esc(f.name)}">${insDocIcon(f.type)} ${esc(f.name)} <small style="color:var(--muted2);">(${insFmtBytes(f.size)})</small></span>
          <input class="search-input ins-cab-input" data-idx="${i}" placeholder="Cab #(s) — e.g. 48, 156, 4322 *" aria-label="Cab number(s) for ${esc(f.name)}" autocomplete="off" />
        </div>`).join('')}
    </div>`;
  insValidateCabs();
}

// Grey the Upload button (but keep it clickable, so a click can explain WHY)
// until every selected file has a cab number.
function insValidateCabs() {
  const inputs = [...document.querySelectorAll('#ins-file-chosen .ins-cab-input')];
  const allFilled = inputs.length > 0 && inputs.every((inp) => inp.value.trim() !== '');
  const btn = document.getElementById('ins-upload-btn');
  if (btn) btn.classList.toggle('is-inactive', !allFilled);
  return allFilled;
}

async function insUpload() {
  if (!insSelectedFiles.length) return;
  const btn    = document.getElementById('ins-upload-btn');
  const status = document.getElementById('ins-upload-status');
  const desc   = document.getElementById('ins-doc-desc').value.trim();
  const cabInputs = [...document.querySelectorAll('#ins-file-chosen .ins-cab-input')];

  // Guard: a cab number is mandatory for every file. The button is greyed but
  // still clickable, so explain WHY on click and point at the missing field(s).
  if (!insValidateCabs()) {
    cabInputs.forEach((inp) => inp.classList.toggle('err', inp.value.trim() === ''));
    const firstEmpty = cabInputs.find((inp) => inp.value.trim() === '');
    if (firstEmpty) firstEmpty.focus();
    const msg = 'Please add the cab number for every document before uploading.';
    status.style.color = 'var(--red)';
    status.textContent = msg;
    showToast(msg, 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading…';
  status.textContent = '';
  try {
    const fd = new FormData();
    // One `files` + one `cab_numbers` per document, in the same order so the
    // server can pair them by index.
    insSelectedFiles.forEach((f, i) => {
      fd.append('files', f);
      fd.append('cab_numbers', (cabInputs[i]?.value || '').trim());
    });
    if (desc) fd.append('description', desc);
    // Raw fetch (not api()) — must NOT set a JSON content-type; the browser sets
    // the multipart boundary itself.
    const res = await fetch(API + '/api/admin/insurance/documents', { method: 'POST', credentials: 'same-origin', body: fd });
    if (res.status === 401) { showLoginPage(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    showToast(`Uploaded ${data.documents.length} file${data.documents.length !== 1 ? 's' : ''}`, 'success');
    // Reset the picker and refresh the list.
    document.getElementById('ins-file-input').value = '';
    document.getElementById('ins-doc-desc').value = '';
    insSetChosen([]);
    loadInsDocuments(1);   // jump to the first page so the new uploads are visible
  } catch (err) {
    status.style.color = 'var(--red)';
    status.textContent = err.message;
  } finally {
    btn.innerHTML = 'Upload';
    insValidateCabs();   // restore the correct disabled state
  }
}

function insOpenPreview(id, name) {
  const url  = `${API}/api/admin/insurance/documents/${id}/preview`;
  const body = document.getElementById('ins-preview-body');
  document.getElementById('ins-preview-title').textContent = name;
  document.getElementById('ins-preview-download').href = `${API}/api/admin/insurance/documents/${id}/download`;
  // Image vs everything-previewable-else (PDF) — the server only serves inline
  // for images/PDF, so an <img> that fails falls back to an <iframe>.
  const isImg = /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name);
  body.innerHTML = isImg
    ? `<img src="${url}" alt="${esc(name)}" style="max-width:100%;max-height:86vh;object-fit:contain;" />`
    : `<iframe src="${url}" title="${esc(name)}" style="width:100%;height:86vh;border:0;background:#fff;"></iframe>`;
  document.getElementById('ins-preview-modal').classList.add('open');
}
function insClosePreview() {
  document.getElementById('ins-preview-modal').classList.remove('open');
  document.getElementById('ins-preview-body').innerHTML = ''; // stop the iframe/img loading
}

function insDownload(id) {
  const a = document.createElement('a');
  a.href = `${API}/api/admin/insurance/documents/${id}/download`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function insDeleteDoc(id, name) {
  const ok = await showConfirm(`Delete "${name}"? This permanently removes the file and cannot be undone.`,
    { title: 'Delete Document', okLabel: 'Delete', icon: '🗑', danger: true });
  if (!ok) return;
  try {
    const data = await api(`/api/admin/insurance/documents/${id}`, { method: 'DELETE' });
    if (!data) return;
    showToast('Document deleted', 'success');
    loadInsDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Pager rendering ──────────────────────────────────────────────────────────
function insPager(scope, total) {
  const el = document.getElementById(`ins-${scope}-pager`);
  if (!el) return;
  const page = insState[scope].page;
  const pages = Math.ceil(total / INS_PER) || 1;
  if (total <= INS_PER) { el.innerHTML = total ? `<div style="padding:12px 4px;font-size:13px;color:var(--muted2);">${total} total</div>` : ''; return; }
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 4px;gap:12px;flex-wrap:wrap;">
      <span style="font-size:13px;color:var(--muted2);">${total} total</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} data-ins-page="prev">← Prev</button>
        <span style="font-size:13px;color:var(--muted2);min-width:90px;text-align:center;">Page ${page} of ${pages}</span>
        <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} data-ins-page="next">Next →</button>
      </div>
    </div>`;
}

const INS_SCOPE_LOADERS = { veh: loadInsVehicles, drv: loadInsDrivers, clm: loadInsClaims, end: loadInsEndorsements, doc: loadInsDocuments };

// ─── Reveal a full DL (audited server-side) ───────────────────────────────────
async function revealInsDl(btn) {
  const entity = btn.dataset.entity; // 'drivers' | 'endorsements'
  const id = btn.dataset.id;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await api(`/api/admin/insurance/${entity}/${id}/reveal-dl`, { method: 'POST' });
    if (!data) return;
    const span = document.createElement('span');
    span.className = 'mono';
    span.textContent = data.dl_number || '—';
    btn.replaceWith(span);
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ─── Wiring (once) ──────────────────────────────────────────────────────────
let insSearchTimer = null;
function wireInsurance() {
  document.getElementById('ins-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.ins-tab');
    if (b) showInsTab(b.dataset.tab);
  });

  document.getElementById('btn-refresh-insurance').addEventListener('click', () => {
    const active = document.querySelector('#ins-tabs .ins-tab.active')?.dataset.tab || 'overview';
    loadInsOverview();
    if (active !== 'overview') loadInsTab(active);
  });

  // Pager + reveal-DL delegation across the whole page.
  document.getElementById('page-insurance').addEventListener('click', (e) => {
    const pageBtn = e.target.closest('[data-ins-page]');
    if (pageBtn) {
      const scope = pageBtn.closest('.pager')?.dataset.scope;
      if (scope && INS_SCOPE_LOADERS[scope]) {
        insState[scope].page += pageBtn.dataset.insPage === 'next' ? 1 : -1;
        INS_SCOPE_LOADERS[scope]();
      }
      return;
    }
    const reveal = e.target.closest('[data-action="reveal-dl"]');
    if (reveal) { revealInsDl(reveal); return; }

    const act = e.target.closest('[data-action]');
    if (act) {
      const id = act.dataset.id;
      if (act.dataset.action === 'doc-preview')  insOpenPreview(id, act.dataset.name);
      if (act.dataset.action === 'doc-download') insDownload(id);
      if (act.dataset.action === 'doc-delete')   insDeleteDoc(id, act.dataset.name);
    }
  });

  // Documents: dropzone + file picker + upload
  const dz = document.getElementById('ins-dropzone');
  const fileInput = document.getElementById('ins-file-input');
  dz.addEventListener('click', (e) => {
    // Don't re-open the file picker when interacting with the controls inside
    // the dropzone (upload button, optional label, or a per-file cab input).
    if (e.target.closest('#ins-upload-btn') || e.target.closest('#ins-doc-desc') ||
        e.target.closest('.ins-cab-input')  || e.target.closest('.ins-upload-list')) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => insSetChosen(fileInput.files));
  // Re-validate the Upload button as cab numbers are typed; clear the error mark
  // on a field once it has a value.
  document.getElementById('ins-file-chosen').addEventListener('input', (e) => {
    if (e.target.classList.contains('ins-cab-input')) {
      if (e.target.value.trim() !== '') e.target.classList.remove('err');
      insValidateCabs();
    }
  });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) insSetChosen(e.dataTransfer.files);
  });
  document.getElementById('ins-upload-btn').addEventListener('click', (e) => { e.stopPropagation(); insUpload(); });

  // Preview modal close (button + backdrop click)
  document.getElementById('ins-preview-close').addEventListener('click', insClosePreview);
  document.getElementById('ins-preview-modal').addEventListener('click', (e) => { if (e.target.id === 'ins-preview-modal') insClosePreview(); });

  // Search inputs (debounced) + filter selects reset to page 1 and reload.
  const onSearch = (scope) => { clearTimeout(insSearchTimer); insSearchTimer = setTimeout(() => INS_SCOPE_LOADERS[scope](1), 300); };
  document.getElementById('ins-veh-search').addEventListener('input', () => onSearch('veh'));
  document.getElementById('ins-veh-status').addEventListener('change', () => loadInsVehicles(1));
  document.getElementById('ins-drv-search').addEventListener('input', () => onSearch('drv'));
  document.getElementById('ins-drv-flag').addEventListener('change', () => loadInsDrivers(1));
  document.getElementById('ins-end-search').addEventListener('input', () => onSearch('end'));
  document.getElementById('ins-doc-search').addEventListener('input', () => onSearch('doc'));
}
