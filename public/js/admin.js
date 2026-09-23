import {
  api, html, raw, $, $$, getConfig, money, fmtDate, fmtMonth, fmtMonths, statusBadge, toast, modal, confirmDialog,
  promptDialog, renderAuth, signOut, changePasswordDialog, onSubmit, formData, download,
} from '/js/common.js';
import { scanReceipt } from '/js/receipt-scan.js';
import { addMonths } from '/shared/receipt-parser.js';

const root = $('#app');
let cfg, me;

const NAV = [
  ['dashboard', '🏠', 'Dashboard'],
  ['entries', '🧾', 'Donation entries'],
  ['section', 'Reports'],
  ['weekly', '📅', 'Weekly report'],
  ['coverage', '👧', 'Orphan coverage'],
  ['beneficiaries', '🏦', 'Beneficiary accounts'],
  ['section', 'Records'],
  ['orphans', '📇', 'Orphans'],
  ['donors', '🤝', 'Donors'],
  ['data', '⇅', 'Import / Export'],
  ['section', 'Administration'],
  ['settings', '⚙️', 'Settings'],
  ['audit', '📜', 'Activity log'],
];

async function start() {
  cfg = await getConfig();
  document.title = `Management · ${cfg.foundationName}`;
  const { user } = await api.get('/api/auth/me');
  if (!user || user.role !== 'admin') {
    renderAuth(root, {
      role: 'admin', title: 'Foundation management', subtitle: 'Sign in with your management account.',
      allowRegister: false, onSignedIn: (u) => { me = u; shell(); },
    });
    return;
  }
  me = user;
  shell();
}

function shell() {
  root.innerHTML = String(html`
    <header class="topbar">
      <button class="icon-btn menu-toggle" id="menu" aria-label="Menu">☰</button>
      <a class="brand" href="#dashboard"><span class="brand-mark">ب</span><span>${cfg.foundationName}</span></a>
      <span class="badge badge-ok">Management</span>
      <span class="spacer"></span>
      <span class="muted small hide-sm">${me.name}</span>
      <button class="btn btn-sm" id="pw">Password</button>
      <button class="btn btn-sm" id="logout">Sign out</button>
    </header>
    <div class="app-shell">
      <nav class="sidebar" id="sidebar">${NAV.map((n) => (n[0] === 'section'
        ? html`<div class="section">${n[1]}</div>`
        : html`<a href="#${n[0]}" data-nav="${n[0]}"><span>${n[1]}</span>${n[2]}${n[0] === 'entries' ? html`<span class="count hidden" id="pending-count"></span>` : ''}</a>`))}
      </nav>
      <main class="main" id="view"></main>
    </div>`);
  $('#logout').onclick = signOut;
  $('#pw').onclick = changePasswordDialog;
  $('#menu').onclick = () => $('#sidebar').classList.toggle('open');
  window.addEventListener('hashchange', route);
  route();
}

async function refreshPendingCount() {
  try {
    const { total } = await api.get('/api/admin/payments?status=pending&limit=1');
    const el = $('#pending-count');
    el.textContent = total;
    el.classList.toggle('hidden', !total);
  } catch { /* ignore */ }
}

const PAGES = {};
function route() {
  const [name, qs] = (location.hash.slice(1) || 'dashboard').split('?');
  const page = PAGES[name] ? name : 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  $('#sidebar').classList.remove('open');
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  PAGES[page](view, new URLSearchParams(qs || '')).catch((e) => {
    view.innerHTML = String(html`<div class="alert alert-danger">${e.message}</div>`);
  });
  refreshPendingCount();
}

const monthInput = (id, value) => html`<label>Month<input type="month" id="${id}" value="${value}"></label>`;
const statusSelect = (id, value) => html`<label>Include<select id="${id}">
  <option value="verified,pending" ${value === 'verified,pending' ? 'selected' : ''}>Verified + pending</option>
  <option value="verified" ${value === 'verified' ? 'selected' : ''}>Verified only</option>
  <option value="pending" ${value === 'pending' ? 'selected' : ''}>Pending only</option>
  <option value="verified,pending,rejected" ${value === 'verified,pending,rejected' ? 'selected' : ''}>All (incl. rejected)</option></select></label>`;

function flagDot(p) { return p.flags?.length ? html`<span class="flag-dot" title="${p.flags.map((f) => f.message).join('\n')}"></span>` : ''; }

function entriesTable(payments, { selectable = false, compact = false } = {}) {
  if (!payments.length) return html`<div class="empty">No entries</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>${selectable ? html`<th><input type="checkbox" id="sel-all" aria-label="Select all"></th>` : ''}<th>#</th><th>Receipt date</th><th>Donor</th><th>Orphan(s)</th><th>Months</th><th class="num">Amount</th>
      ${compact ? '' : html`<th>Beneficiary</th><th>Txn ID</th>`}<th>Status</th></tr></thead>
    <tbody>${payments.map((p) => html`
      <tr class="clickable" data-id="${p.id}">
        ${selectable ? html`<td data-noopen><input type="checkbox" class="sel" value="${p.id}" ${p.status !== 'pending' ? 'disabled' : ''} aria-label="Select entry ${p.id}"></td>` : ''}
        <td>${p.id}${flagDot(p)}</td>
        <td class="nowrap">${fmtDate(p.payment_date)}</td>
        <td>${p.donor_name}<div class="muted small">${p.donor_phone || p.donor_email || ''}</div></td>
        <td>${p.orphan_nos.join(', ')}</td>
        <td>${fmtMonths(p.months)}</td>
        <td class="num">${money(p.amount)}</td>
        ${compact ? '' : html`<td>${p.beneficiary_name || html`<span class="muted">—</span>`}<div class="muted small mono">${p.beneficiary_account || ''}</div></td><td class="mono small">${p.transaction_ref || ''}</td>`}
        <td>${statusBadge(p.status)}</td>
      </tr>`)}</tbody></table></div>`;
}

function bindEntryRows(container, payments, onChange) {
  $$('tr[data-id]', container).forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-noopen]')) return;
      openEntry(Number(tr.dataset.id), onChange);
    });
  });
}

// ---- Dashboard --------------------------------------------------------------

PAGES.dashboard = async (view, qs) => {
  const month = qs.get('month') || cfg.month;
  const d = await api.get(`/api/admin/dashboard?month=${month}`);
  const maxWeek = Math.max(1, ...d.weeks.map((w) => w.total));
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Dashboard</h1><p class="muted">${d.month_label} · today ${fmtDate(d.today)}</p></div>
      <div class="filters" style="margin:0">${monthInput('dash-month', month)}</div>
    </div>
    ${d.pending_all ? html`<div class="alert alert-warn">${d.pending_all} entr${d.pending_all === 1 ? 'y is' : 'ies are'} waiting for review${d.flagged_pending ? html`, <strong>${d.flagged_pending} with warnings</strong>` : ''}. <a href="#entries?status=pending">Review now →</a></div>` : ''}
    <div class="grid grid-4">
      <div class="card stat accent"><div class="label">Verified this month</div><div class="value">${money(d.verified.total)}</div><div class="sub">${d.verified.n} receipts</div></div>
      <div class="card stat warn"><div class="label">Pending review</div><div class="value">${money(d.pending.total)}</div><div class="sub">${d.pending.n} receipts</div></div>
      <div class="card stat"><div class="label">Orphans paid for ${fmtMonth(month)}</div><div class="value">${d.coverage.paid} / ${d.coverage.orphans}</div><div class="sub">${d.coverage.partial} partial · ${d.coverage.unpaid} unpaid</div></div>
      <div class="card stat danger"><div class="label">Rejected</div><div class="value">${d.rejected.n}</div><div class="sub">${d.donors} donors · ${d.orphans} active orphans</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card" style="margin:0">
        <div class="card-head"><h3>Week by week (by receipt date)</h3><a class="btn btn-sm" href="#weekly?month=${month}">Full report</a></div>
        ${d.weeks.map((w) => html`
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between" class="small"><strong>Week ${w.week}</strong><span class="muted">${fmtDate(w.from)} – ${fmtDate(w.to)}</span><span><strong>${money(w.total)}</strong> · ${w.count}</span></div>
            <div class="bar" style="margin-top:4px">
              <span class="c" style="width:${(w.current_total / maxWeek) * 100}%"></span>
              <span class="a" style="width:${(w.advance_total / maxWeek) * 100}%"></span>
              <span class="r" style="width:${(w.arrears_total / maxWeek) * 100}%"></span>
            </div>
          </div>`)}
        <div class="legend"><span><i style="background:var(--primary)"></i>Current month</span><span><i style="background:var(--accent)"></i>Advance</span><span><i style="background:var(--info)"></i>Arrears</span></div>
      </div>
      <div class="card" style="margin:0">
        <div class="card-head"><h3>Paid into</h3><a class="btn btn-sm" href="#beneficiaries">Details</a></div>
        ${d.beneficiaries.length ? html`<table><tbody>${d.beneficiaries.map((b) => html`
          <tr><td>${b.beneficiary_name}<div class="muted small mono">${b.beneficiary_account}</div></td>
          <td>${b.official ? html`<span class="badge badge-ok">Official</span>` : html`<span class="badge badge-bad">Not registered</span>`}</td>
          <td class="num">${money(b.total)}<div class="muted small">${b.count} receipts</div></td></tr>`)}</tbody></table>` : html`<div class="empty">No receipts this month</div>`}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Latest entries</h3><a class="btn btn-sm" href="#entries">All entries</a></div>
      <div id="recent">${entriesTable(d.recent, { compact: true })}</div>
    </div>`);
  $('#dash-month').onchange = (e) => { location.hash = `dashboard?month=${e.target.value}`; };
  bindEntryRows($('#recent'), d.recent, route);
};

// ---- Entries ------------------------------------------------------------------

PAGES.entries = async (view, qs) => {
  const f = {
    status: qs.get('status') ?? 'pending', month: qs.get('month') || '', q: qs.get('q') || '',
    flagged: qs.get('flagged') || '', orphan_no: qs.get('orphan_no') || '', covers_month: qs.get('covers_month') || '',
  };
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Donation entries</h1><p class="muted">Review receipts submitted by donors. Click an entry to verify or reject it.</p></div>
      <button class="btn" id="add-entry">＋ Manual entry</button>
    </div>
    <form class="filters" id="filters">
      <label>Status<select name="status">
        ${[['pending', 'Pending review'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['', 'All']].map(([v, l]) => html`<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`)}
      </select></label>
      <label>Receipt month<input type="month" name="month" value="${f.month}"></label>
      <label>Covers month<input type="month" name="covers_month" value="${f.covers_month}"></label>
      <label>Orphan no.<input name="orphan_no" value="${f.orphan_no}" style="width:110px"></label>
      <label style="flex:1;min-width:180px">Search<input name="q" value="${f.q}" placeholder="Donor, phone, txn ID, account, #id"></label>
      <label class="check"><input type="checkbox" name="flagged" value="1" ${f.flagged ? 'checked' : ''}>With warnings</label>
      <button class="btn btn-primary">Filter</button>
    </form>
    <div id="bulk" class="actions hidden" style="justify-content:flex-start;margin:0 0 10px"><button class="btn btn-ok btn-sm" id="bulk-verify">✓ Verify selected</button></div>
    <div id="list"><div class="empty">Loading…</div></div>`);

  $('#filters').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(e.target).entries()) if (v !== '' || k === 'status') p.set(k, v);
    location.hash = `entries?${p}`;
  };
  $('#add-entry').onclick = manualEntry;

  const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
  p.set('limit', 500);
  const data = await api.get(`/api/admin/payments?${p}`);
  const list = $('#list');
  list.innerHTML = String(html`<p class="muted small">${data.total} entr${data.total === 1 ? 'y' : 'ies'} · ${money(data.amount)}${data.total > data.payments.length ? ` (showing first ${data.payments.length})` : ''}</p>
    ${entriesTable(data.payments, { selectable: true })}`);
  bindEntryRows(list, data.payments, route);

  const bulk = $('#bulk');
  const updateBulk = () => bulk.classList.toggle('hidden', !$$('.sel:checked', list).length);
  list.addEventListener('change', updateBulk);
  $('#sel-all', list)?.addEventListener('change', (e) => { $$('.sel:not(:disabled)', list).forEach((c) => { c.checked = e.target.checked; }); updateBulk(); });
  $('#bulk-verify').onclick = async () => {
    const ids = $$('.sel:checked', list).map((c) => Number(c.value));
    if (!(await confirmDialog(`Verify ${ids.length} selected entr${ids.length === 1 ? 'y' : 'ies'}?`, { okLabel: 'Verify' }))) return;
    await api.post('/api/admin/payments/bulk-verify', { ids });
    toast(`${ids.length} entries verified`);
    route();
  };
};

async function openEntry(id, onChange) {
  const { payment: p } = await api.get(`/api/admin/payments/${id}`);
  const official = cfg.officialAccounts;
  const m = modal(`Entry #${p.id} · ${p.donor_name}`, html`
    <div class="grid grid-2">
      <div>
        ${p.has_image ? html`<img class="receipt-img-lg" id="rimg" src="/api/payments/${p.id}/image" alt="Receipt image">
          <div class="actions" style="justify-content:flex-start;margin-top:8px"><a class="btn btn-sm" href="/api/payments/${p.id}/image" target="_blank" rel="noopener">Open full size</a>
          <button class="btn btn-sm" id="reread">Re-read receipt</button></div>`
          : html`<div class="empty card">No receipt image (${p.source === 'import' ? 'imported record' : 'manual entry'})</div>`}
        <div id="reread-out"></div>
        ${p.ocr_text ? html`<details style="margin-top:10px"><summary class="small">Text read from receipt (clarity ${p.ocr_confidence ?? '–'}%, sharpness ${p.sharpness ?? '–'})</summary><pre class="ocr">${p.ocr_text}</pre></details>` : ''}
        ${p.receipt_text && p.receipt_text !== p.ocr_text?.trim() ? html`<details style="margin-top:8px"><summary class="small">Receipt text entered by donor</summary><pre class="ocr">${p.receipt_text}</pre></details>` : ''}
      </div>
      <div>
        <p>${statusBadge(p.status)} <span class="badge badge-muted">${p.source}</span>
          <span class="muted small">submitted ${p.submitted_at}${p.reviewed_at ? ` · reviewed ${p.reviewed_at}${p.reviewed_by_name ? ` by ${p.reviewed_by_name}` : ''}` : ''}</span></p>
        ${p.flags.length ? html`<ul class="flag-list">${p.flags.map((f) => html`<li>⚠ ${f.message}</li>`)}</ul>` : html`<div class="alert alert-ok">No automatic warnings</div>`}
        ${p.donor_note ? html`<div class="alert alert-info"><strong>Donor note:</strong> ${p.donor_note}</div>` : ''}
        <form id="edit" class="form-grid">
          <label>Receipt date<input type="date" name="payment_date" value="${p.payment_date}"></label>
          <label>Amount<input name="amount" value="${p.amount}"></label>
          <label>Orphan no(s) <span class="hint">separate with ;</span><input name="orphan_nos" value="${p.orphan_nos.join('; ')}"></label>
          <label>Months <span class="hint">YYYY-MM; …</span><input name="months" value="${p.months.join('; ')}"></label>
          <label>Transaction ID<input name="transaction_ref" value="${p.transaction_ref}"></label>
          <label>Bank / wallet<input name="bank_name" value="${p.bank_name}"></label>
          <label>Beneficiary name<input name="beneficiary_name" value="${p.beneficiary_name}"></label>
          <label>Beneficiary account<input name="beneficiary_account" class="mono" value="${p.beneficiary_account}" list="official-accts"></label>
          <label>Beneficiary bank<input name="beneficiary_bank" value="${p.beneficiary_bank}"></label>
          <label>Sender<input name="sender_name" value="${p.sender_name}"></label>
          <label class="full">Management note <span class="hint">(shown to donor if rejected)</span><input name="admin_note" value="${p.admin_note}"></label>
          <datalist id="official-accts">${official.map((a) => html`<option value="${a.account}">${a.title}</option>`)}</datalist>
          <div class="full"><table class="small"><thead><tr><th>Orphan</th><th>Month</th><th class="num">Amount</th></tr></thead>
            <tbody>${p.allocations.map((a) => html`<tr><td>${a.orphan_no} · ${a.orphan_name}</td><td>${fmtMonth(a.month)}</td><td class="num">${money(a.amount)}</td></tr>`)}</tbody></table></div>
          <div class="form-error full" role="alert"></div>
          <div class="full actions" style="justify-content:space-between">
            <button type="button" class="btn btn-sm" id="del" style="color:var(--danger)">Delete</button>
            <span style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="submit" class="btn">Save changes</button>
              ${p.status !== 'rejected' ? html`<button type="button" class="btn btn-danger" id="reject">Reject</button>` : ''}
              ${p.status !== 'verified' ? html`<button type="button" class="btn btn-ok" id="verify">✓ Verify</button>` : ''}
              ${p.status !== 'pending' ? html`<button type="button" class="btn" id="reopen">Back to pending</button>` : ''}
            </span>
          </div>
        </form>
        <p class="muted small" style="margin-top:10px">Donor: ${p.donor_name} · ${p.donor_phone || ''} ${p.donor_email || ''}</p>
      </div>
    </div>`, { wide: true });

  const done = (msg) => { m.close(); toast(msg); onChange?.(); };
  const form = $('#edit', m.el);
  const payload = () => {
    const d = formData(form);
    return { ...d, orphan_nos: d.orphan_nos.split(/[;,]/).map((s) => s.trim()).filter(Boolean), months: d.months.split(/[;,]/).map((s) => s.trim()).filter(Boolean) };
  };
  onSubmit(form, async () => { await api.put(`/api/admin/payments/${id}`, payload()); done('Entry updated'); });
  $('#rimg', m.el)?.addEventListener('click', (e) => e.target.classList.toggle('zoom'));
  $('#verify', m.el)?.addEventListener('click', async () => {
    await api.put(`/api/admin/payments/${id}`, payload());
    await api.post(`/api/admin/payments/${id}/verify`, {});
    done(`Entry #${id} verified`);
  });
  $('#reject', m.el)?.addEventListener('click', async () => {
    const note = await promptDialog('Reject entry', 'Reason (the donor will see this)', { okLabel: 'Reject' });
    if (!note) return;
    await api.post(`/api/admin/payments/${id}/reject`, { note });
    done(`Entry #${id} rejected`);
  });
  $('#reopen', m.el)?.addEventListener('click', async () => { await api.post(`/api/admin/payments/${id}/reopen`, {}); done('Moved back to pending'); });
  $('#del', m.el).addEventListener('click', async () => {
    if (!(await confirmDialog(`Permanently delete entry #${id} and its receipt image?`, { okLabel: 'Delete', danger: true }))) return;
    await api.del(`/api/admin/payments/${id}`);
    done('Entry deleted');
  });
  $('#reread', m.el)?.addEventListener('click', async (e) => {
    const out = $('#reread-out', m.el);
    e.target.disabled = true;
    out.innerHTML = '<p class="muted small">Reading receipt…</p>';
    try {
      const blob = await (await fetch(`/api/payments/${id}/image`)).blob();
      const scan = await scanReceipt(new File([blob], 'receipt', { type: blob.type }));
      const x = scan.parsed;
      out.innerHTML = String(html`<div class="card" style="margin-top:10px"><strong>Read now</strong>
        ${scan.ocrError ? html`<p class="alert alert-warn">${scan.ocrError}</p>` : ''}
        <dl class="kv small"><dt>Clarity / sharpness</dt><dd>${scan.confidence ?? '–'}% / ${scan.sharpness}</dd>
        <dt>Dates</dt><dd>${x.dates.map(fmtDate).join(', ') || '—'}</dd><dt>Amount</dt><dd>${x.amount ?? '—'}</dd>
        <dt>Beneficiary</dt><dd>${x.beneficiaryName || '—'} <span class="mono">${x.beneficiaryAccount}</span></dd>
        <dt>Transaction ID</dt><dd>${x.transactionRef || '—'}</dd></dl>
        <button class="btn btn-sm" id="apply-scan">Use these values</button></div>`);
      $('#apply-scan', out).onclick = () => {
        if (x.paymentDate) form.payment_date.value = x.paymentDate;
        if (x.amount) form.amount.value = x.amount;
        if (x.transactionRef) form.transaction_ref.value = x.transactionRef;
        if (x.beneficiaryName) form.beneficiary_name.value = x.beneficiaryName;
        if (x.beneficiaryAccount) form.beneficiary_account.value = x.beneficiaryAccount;
        if (x.beneficiaryBank) form.beneficiary_bank.value = x.beneficiaryBank;
        toast('Values applied. Click Save changes to keep them.');
      };
    } catch (err) {
      out.innerHTML = String(html`<p class="alert alert-danger">${err.message}</p>`);
    } finally {
      e.target.disabled = false;
    }
  });
}

async function manualEntry() {
  const { donors } = await api.get('/api/admin/donors');
  const m = modal('Manual donation entry', html`
    <form class="form-grid">
      <p class="full muted small">Record a donation on behalf of a donor (e.g. received by cash, or receipt sent on WhatsApp). The current-month rule does not apply here; entries outside this month are marked with a warning.</p>
      <label class="full">Donor<select name="donor_id" required><option value="">Select donor…</option>${donors.map((d) => html`<option value="${d.id}">${d.name} ${d.phone ? `· ${d.phone}` : ''}</option>`)}</select></label>
      <label>Orphan no(s)<input name="orphan_nos" required placeholder="BUA-001; BUA-002"></label>
      <label>Months<input name="months" required placeholder="${cfg.month}; ${addMonths(cfg.month, 1)}"></label>
      <label>Receipt date<input type="date" name="payment_date" required value="${cfg.today}"></label>
      <label>Amount<input name="amount" required></label>
      <label>Transaction ID<input name="transaction_ref"></label>
      <label>Bank / wallet<input name="bank_name"></label>
      <label>Beneficiary name<input name="beneficiary_name"></label>
      <label>Beneficiary account<input name="beneficiary_account" list="official-accts2"></label>
      <datalist id="official-accts2">${cfg.officialAccounts.map((a) => html`<option value="${a.account}">${a.title}</option>`)}</datalist>
      <label class="full">Receipt image (optional)<input type="file" name="receipt" accept="image/*"></label>
      <label class="full">Note<input name="admin_note"></label>
      <div class="form-error full" role="alert"></div>
      <div class="full actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save entry</button></div>
    </form>`, { wide: false });
  onSubmit($('form', m.el), async (e) => {
    const fd = new FormData(e.target);
    const file = fd.get('receipt');
    if (!file || !file.size) fd.delete('receipt');
    const { payment } = await api.post('/api/admin/payments', fd);
    m.close();
    toast(`Entry #${payment.id} saved (pending review)`);
    route();
  });
}

// ---- Weekly report --------------------------------------------------------------

PAGES.weekly = async (view, qs) => {
  const month = qs.get('month') || cfg.month;
  const status = qs.get('status') || 'verified,pending';
  const r = await api.get(`/api/admin/reports/weekly?month=${month}&status=${status}`);
  const t = r.totals;
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Weekly report · ${r.month_label}</h1>
        <p class="muted">Receipts grouped by the date on the bank receipt. Week 1 = 1st–7th, week 2 = 8th–14th, week 3 = 15th–21st, week 4 = 22nd–28th, week 5 = 29th to month end.</p></div>
      <div class="no-print" style="display:flex;gap:8px"><button class="btn" id="csv">⬇ Excel/CSV</button><button class="btn" onclick="window.print()">🖨 Print / PDF</button></div>
    </div>
    <div class="print-only"><h2>${cfg.foundationName} · Weekly donation report · ${r.month_label}</h2><p>Includes: ${r.statuses.join(', ')}</p></div>
    <div class="filters">${monthInput('w-month', month)}${statusSelect('w-status', status)}</div>
    <div class="grid grid-4">
      <div class="card stat accent"><div class="label">Total received</div><div class="value">${money(t.total)}</div><div class="sub">${t.count} receipts · ${t.donors} donors</div></div>
      <div class="card stat"><div class="label">For ${fmtMonth(month)}</div><div class="value">${money(t.current_total)}</div></div>
      <div class="card stat warn"><div class="label">Advance (future months)</div><div class="value">${money(t.advance_total)}</div></div>
      <div class="card stat"><div class="label">Arrears (past months)</div><div class="value">${money(t.arrears_total)}</div><div class="sub">${t.orphans} orphans</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Summary by week</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Week</th><th>Dates</th><th class="num">Receipts</th><th class="num">Current month</th><th class="num">Advance</th><th class="num">Arrears</th><th class="num">Total</th></tr></thead>
        <tbody>${r.weeks.map((w) => html`<tr><td><strong>Week ${w.week}</strong></td><td>${fmtDate(w.from)} – ${fmtDate(w.to)}</td><td class="num">${w.count}</td>
          <td class="num">${money(w.current_total)}</td><td class="num">${money(w.advance_total)}</td><td class="num">${money(w.arrears_total)}</td><td class="num"><strong>${money(w.total)}</strong></td></tr>`)}</tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="num">${t.count}</td><td class="num">${money(t.current_total)}</td><td class="num">${money(t.advance_total)}</td><td class="num">${money(t.arrears_total)}</td><td class="num">${money(t.total)}</td></tr></tfoot>
      </table></div>
    </div>
    ${r.weeks.map((w) => html`
      <div class="card week-card">
        <div class="card-head"><h3>Week ${w.week} <span class="muted small">${fmtDate(w.from)} – ${fmtDate(w.to)}</span></h3><strong>${money(w.total)}</strong><span class="muted small">${w.count} receipts</span></div>
        ${w.entries.length ? html`
          ${w.beneficiaries.length ? html`<p class="small"><strong>Paid into:</strong> ${w.beneficiaries.map((b, i) => html`${i ? ' · ' : ''}${b.beneficiary_name} <span class="mono">${b.beneficiary_account}</span> ${b.official ? '' : html`<span class="badge badge-bad">not registered</span>`} = ${money(b.total)}`)}</p>` : ''}
          <div data-week="${w.week}">${entriesTable(w.entries)}</div>` : html`<p class="muted">No receipts in this week.</p>`}
      </div>`)}`);
  const go = () => { location.hash = `weekly?month=${$('#w-month').value}&status=${$('#w-status').value}`; };
  $('#w-month').onchange = go;
  $('#w-status').onchange = go;
  $('#csv').onclick = () => download(`/api/admin/reports/weekly.csv?month=${month}&status=${status}`);
  r.weeks.forEach((w) => { const el = $(`[data-week="${w.week}"]`); if (el) bindEntryRows(el, w.entries, route); });
};

// ---- Coverage -----------------------------------------------------------------

PAGES.coverage = async (view, qs) => {
  const month = qs.get('month') || cfg.month;
  const status = qs.get('status') || 'verified,pending';
  const r = await api.get(`/api/admin/reports/coverage?month=${month}&status=${status}`);
  const s = r.summary;
  const filter = qs.get('state') || '';
  const rows = filter ? r.rows.filter((x) => x.state === filter) : r.rows;
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Orphan coverage · ${r.month_label}</h1><p class="muted">Which orphans are paid for this month, including months paid in advance earlier.</p></div>
      <div class="no-print" style="display:flex;gap:8px"><button class="btn" id="csv">⬇ Excel/CSV</button><button class="btn" onclick="window.print()">🖨 Print</button></div>
    </div>
    <div class="filters">${monthInput('c-month', month)}${statusSelect('c-status', status)}
      <label>Show<select id="c-state"><option value="">All</option><option value="unpaid" ${filter === 'unpaid' ? 'selected' : ''}>Unpaid</option><option value="partial" ${filter === 'partial' ? 'selected' : ''}>Partial</option><option value="paid" ${filter === 'paid' ? 'selected' : ''}>Paid</option></select></label></div>
    <div class="grid grid-4">
      <div class="card stat accent"><div class="label">Paid</div><div class="value">${s.paid}</div><div class="sub">of ${s.orphans} orphans</div></div>
      <div class="card stat warn"><div class="label">Partial</div><div class="value">${s.partial}</div></div>
      <div class="card stat danger"><div class="label">Unpaid</div><div class="value">${s.unpaid}</div></div>
      <div class="card stat"><div class="label">Received / expected</div><div class="value">${money(s.received)}</div><div class="sub">of ${money(s.expected)}</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Orphan no.</th><th>Name</th><th>Sponsor(s)</th><th class="num">Monthly</th><th class="num">Paid</th><th>Status</th><th>Entries</th></tr></thead>
      <tbody>${rows.map((x) => html`<tr>
        <td class="mono">${x.orphan_no}</td><td>${x.orphan_name}<div class="muted small">${x.guardian_name || ''}</div></td>
        <td>${x.sponsors.map((sp) => html`<div>${sp.name} <span class="muted small">${sp.phone || ''}</span></div>`)}</td>
        <td class="num">${money(x.monthly_amount)}</td><td class="num">${money(x.paid)}</td>
        <td><span class="badge badge-${x.state}">${x.state}</span>${x.paid_in_advance ? html` <span class="badge badge-info">advance</span>` : ''}</td>
        <td>${x.payments.map((p) => html`<a href="#" data-open="${p.id}">#${p.id}</a> `)}</td></tr>`)}</tbody>
    </table></div></div>`);
  const go = () => { location.hash = `coverage?month=${$('#c-month').value}&status=${$('#c-status').value}&state=${$('#c-state').value}`; };
  ['#c-month', '#c-status', '#c-state'].forEach((s) => { $(s).onchange = go; });
  $('#csv').onclick = () => download(`/api/admin/reports/coverage.csv?month=${month}&status=${status}`);
  $$('[data-open]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openEntry(Number(a.dataset.open), route); }; });
};

// ---- Beneficiaries ----------------------------------------------------------------

PAGES.beneficiaries = async (view, qs) => {
  const from = qs.get('from') || `${cfg.month}-01`;
  const to = qs.get('to') || cfg.today;
  const status = qs.get('status') || 'verified,pending';
  const r = await api.get(`/api/admin/reports/beneficiaries?from=${from}&to=${to}&status=${status}`);
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Beneficiary accounts</h1><p class="muted">Accounts that donors paid into, taken from their payment screenshots. Accounts that are not registered foundation accounts are highlighted.</p></div>
      <div class="no-print" style="display:flex;gap:8px"><button class="btn" id="csv">⬇ Excel/CSV</button><button class="btn" onclick="window.print()">🖨 Print</button></div>
    </div>
    <div class="filters">
      <label>From<input type="date" id="b-from" value="${from}"></label><label>To<input type="date" id="b-to" value="${to}"></label>${statusSelect('b-status', status)}
    </div>
    <div class="grid grid-3">
      <div class="card stat accent"><div class="label">Total</div><div class="value">${money(r.total)}</div><div class="sub">${r.count} receipts</div></div>
      <div class="card stat"><div class="label">Registered accounts</div><div class="value">${money(r.groups.filter((g) => g.official).reduce((a, g) => a + g.total, 0))}</div></div>
      <div class="card stat danger"><div class="label">Other / unidentified accounts</div><div class="value">${money(r.groups.filter((g) => !g.official).reduce((a, g) => a + g.total, 0))}</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Beneficiary</th><th>Account / IBAN</th><th>Bank</th><th></th><th class="num">Receipts</th><th class="num">Total</th><th>Period</th><th></th></tr></thead>
      <tbody>${r.groups.map((g) => html`<tr>
        <td>${g.beneficiary_name}</td><td class="mono">${g.beneficiary_account || '—'}</td><td>${g.beneficiary_bank}</td>
        <td>${g.official ? html`<span class="badge badge-ok">Official</span>` : html`<span class="badge badge-bad">Not registered</span>`}</td>
        <td class="num">${g.count}</td><td class="num"><strong>${money(g.total)}</strong></td><td class="small">${fmtDate(g.first_date)} – ${fmtDate(g.last_date)}</td>
        <td><a href="#entries?status=&q=${encodeURIComponent(g.beneficiary_account || g.beneficiary_name)}">Entries</a></td></tr>`)}</tbody>
    </table></div>${r.groups.length ? '' : html`<div class="empty">No receipts in this period</div>`}</div>`);
  const go = () => { location.hash = `beneficiaries?from=${$('#b-from').value}&to=${$('#b-to').value}&status=${$('#b-status').value}`; };
  ['#b-from', '#b-to', '#b-status'].forEach((s) => { $(s).onchange = go; });
  $('#csv').onclick = () => download(`/api/admin/reports/beneficiaries.csv?from=${from}&to=${to}&status=${status}`);
};

// ---- Orphans ------------------------------------------------------------------

PAGES.orphans = async (view) => {
  const { orphans } = await api.get('/api/admin/orphans');
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Orphans</h1><p class="muted">${orphans.filter((o) => o.status === 'active').length} active · ${orphans.length} total</p></div>
      <button class="btn" id="exp">⬇ Export</button><a class="btn" href="#data">⇪ Import</a><button class="btn btn-primary" id="add">＋ Add orphan</button>
    </div>
    <div class="filters"><label style="flex:1">Search<input id="o-q" placeholder="Number, name (English or Arabic), phone, sponsor"></label></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Orphan no.</th><th>Name</th><th>Child phone</th><th>Guardian</th><th>City</th><th class="num">Monthly</th><th>Sponsor(s)</th><th>Paid until</th><th>Status</th></tr></thead>
      <tbody id="o-body">${orphans.map((o) => html`<tr class="clickable" data-id="${o.id}" data-text="${[o.orphan_no, o.name, o.name_ar, o.child_phone, o.guardian_name, o.sponsors, o.city].join(' ').toLowerCase()}">
        <td class="mono">${o.orphan_no}</td><td>${o.name}${o.name_ar ? html`<div class="muted small" dir="rtl" lang="ar">${o.name_ar}</div>` : ''}</td><td class="mono small nowrap">${o.child_phone || ''}</td><td>${o.guardian_name || ''}</td><td>${o.city || ''}</td><td class="num">${money(o.monthly_amount)}</td>
        <td class="small">${o.sponsors || html`<span class="muted">—</span>`}</td>
        <td>${o.paid_until ? html`<span class="${o.paid_until < cfg.month ? '' : 'badge badge-ok'}">${fmtMonth(o.paid_until)}</span>` : html`<span class="muted">—</span>`}</td>
        <td><span class="badge ${o.status === 'active' ? 'badge-ok' : 'badge-muted'}">${o.status}</span></td></tr>`)}</tbody>
    </table>${orphans.length ? '' : html`<div class="empty">No orphans yet. Add them one by one or import a CSV file.</div>`}</div>`);
  $('#o-q').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('#o-body tr').forEach((tr) => { tr.style.display = tr.dataset.text.includes(q) ? '' : 'none'; });
  };
  $('#add').onclick = () => orphanForm();
  $('#exp').onclick = () => download('/api/admin/export/orphans.csv');
  $$('#o-body tr').forEach((tr) => { tr.onclick = () => orphanForm(orphans.find((o) => o.id === Number(tr.dataset.id))); });
};

function orphanForm(o = {}) {
  const m = modal(o.id ? `Edit orphan ${o.orphan_no}` : 'Add orphan', html`
    <form class="form-grid">
      <label>Orphan number<input name="orphan_no" required value="${o.orphan_no || ''}" placeholder="BUA-001"></label>
      <label>Monthly sponsorship (${cfg.currency})<input name="monthly_amount" inputmode="decimal" value="${o.monthly_amount ?? ''}"></label>
      <label>Name<input name="name" required value="${o.name || ''}"></label>
      <label>Name (Arabic)<input name="name_ar" dir="rtl" lang="ar" value="${o.name_ar || ''}"></label>
      <label>Child / family phone<input name="child_phone" inputmode="tel" value="${o.child_phone || ''}"></label>
      <label>Guardian name<input name="guardian_name" value="${o.guardian_name || ''}"></label>
      <label>Date of birth<input type="date" name="date_of_birth" value="${o.date_of_birth || ''}"></label>
      <label>City<input name="city" value="${o.city || ''}"></label>
      <label>Status<select name="status"><option value="active">Active</option><option value="inactive" ${o.status === 'inactive' ? 'selected' : ''}>Inactive</option></select></label>
      <label class="full">Notes<textarea name="notes" rows="2">${o.notes || ''}</textarea></label>
      <div class="form-error full" role="alert"></div>
      <div class="full actions" style="justify-content:space-between">
        ${o.id ? html`<button type="button" class="btn btn-sm" id="del" style="color:var(--danger)">Delete</button>` : html`<span></span>`}
        <span><button type="button" class="btn" data-close>Cancel</button> <button class="btn btn-primary" type="submit">Save</button></span></div>
    </form>`);
  onSubmit($('form', m.el), async (e) => {
    if (o.id) await api.put(`/api/admin/orphans/${o.id}`, formData(e.target));
    else await api.post('/api/admin/orphans', formData(e.target));
    m.close();
    toast('Orphan saved');
    route();
  });
  $('#del', m.el)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete orphan ${o.orphan_no}?`, { danger: true, okLabel: 'Delete' }))) return;
    try { await api.del(`/api/admin/orphans/${o.id}`); m.close(); toast('Deleted'); route(); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---- Donors -------------------------------------------------------------------

PAGES.donors = async (view) => {
  const { donors } = await api.get('/api/admin/donors');
  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>Donors</h1><p class="muted">${donors.length} donors</p></div>
      <button class="btn" id="exp">⬇ Export</button><a class="btn" href="#data">⇪ Import</a><button class="btn btn-primary" id="add">＋ Add donor</button>
    </div>
    <div class="filters"><label style="flex:1">Search<input id="d-q" placeholder="Name, phone, email, SP code, orphan no."></label></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>SP code</th><th>Phone / email</th><th>City</th><th>Orphans</th><th class="num">Entries</th><th class="num">Verified total</th><th>Last receipt</th><th>Login</th></tr></thead>
      <tbody id="d-body">${donors.map((d) => html`<tr class="clickable" data-id="${d.id}" data-text="${[d.name, d.phone, d.email, d.sponsor_code, d.orphan_nos, d.city].join(' ').toLowerCase()}">
        <td>${d.name}${d.active ? '' : html` <span class="badge badge-muted">inactive</span>`}</td><td class="mono small">${(d.sponsor_code || '').split(';').join(', ')}</td><td>${d.phone || ''}<div class="muted small">${d.email || ''}</div></td><td>${d.city || ''}</td>
        <td class="mono small">${(d.orphan_nos || '').split(';').join(', ')}</td><td class="num">${d.entries}</td><td class="num">${money(d.verified_total)}</td>
        <td>${fmtDate(d.last_payment)}</td><td>${d.can_login ? html`<span class="badge badge-ok">yes</span>` : html`<span class="badge badge-muted">no password</span>`}</td></tr>`)}</tbody>
    </table>${donors.length ? '' : html`<div class="empty">No donors yet</div>`}</div>`);
  $('#d-q').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('#d-body tr').forEach((tr) => { tr.style.display = tr.dataset.text.includes(q) ? '' : 'none'; });
  };
  $('#add').onclick = () => donorForm();
  $('#exp').onclick = () => download('/api/admin/export/donors.csv');
  $$('#d-body tr').forEach((tr) => { tr.onclick = () => donorForm(donors.find((d) => d.id === Number(tr.dataset.id))); });
};

function donorForm(d = {}) {
  const m = modal(d.id ? `Donor · ${d.name}` : 'Add donor', html`
    <form class="form-grid" id="donor-form">
      <label>Name<input name="name" required value="${d.name || ''}"></label>
      <label>Phone<input name="phone" value="${d.phone || ''}"></label>
      <label>Email<input name="email" type="email" value="${d.email || ''}"></label>
      <label>City<input name="city" value="${d.city || ''}"></label>
      <label>Sponsor code <span class="hint">e.g. SP11</span><input name="sponsor_code" value="${d.sponsor_code || ''}"></label>
      <label class="full">Sponsored orphan numbers <span class="hint">separate with ;</span><input name="orphan_nos" value="${(d.orphan_nos || '').split(';').join('; ')}"></label>
      ${d.id ? html`<label class="check full"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}>Active (can sign in)</label>`
        : html`<label class="full">Password <span class="hint">(optional; the donor signs in with phone/email + this password)</span><input name="password" type="text" minlength="6"></label>`}
      <div class="form-error full" role="alert"></div>
      <div class="full actions" style="justify-content:space-between">
        ${d.id ? html`<span style="display:flex;gap:8px"><button type="button" class="btn btn-sm" id="reset">Set password</button><a class="btn btn-sm" href="#entries?status=&q=${encodeURIComponent(d.phone || d.email || d.name)}">View entries</a></span>` : html`<span></span>`}
        <span><button type="button" class="btn" data-close>Cancel</button> <button class="btn btn-primary" type="submit">Save</button></span></div>
    </form>`);
  onSubmit($('form', m.el), async (e) => {
    const body = formData(e.target);
    let res;
    if (d.id) res = await api.put(`/api/admin/donors/${d.id}`, { ...body, active: e.target.active.checked });
    else res = await api.post('/api/admin/donors', body);
    m.close();
    toast(res.missing_orphans?.length ? `Saved. Unknown orphan numbers: ${res.missing_orphans.join(', ')}` : 'Donor saved', res.missing_orphans?.length ? 'error' : 'ok');
    route();
  });
  $('#reset', m.el)?.addEventListener('click', async () => {
    const pw = await promptDialog('Set donor password', 'New password (min 6 characters). Share it with the donor.');
    if (!pw) return;
    try { await api.post(`/api/admin/donors/${d.id}/password`, { password: pw }); toast('Password set'); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---- Import / export -----------------------------------------------------------

PAGES.data = async (view) => {
  view.innerHTML = String(html`
    <div class="page-head"><div class="grow"><h1>Import / Export</h1><p class="muted">Exports are CSV files that open directly in Excel and Google Sheets. Imports take an Excel (.xlsx) or CSV file.</p></div></div>
    <div class="grid grid-2">
      <div class="card" style="margin:0">
        <div class="card-head"><h3>Export</h3></div>
        <form class="stack" id="exp-form">
          <div class="form-grid"><label>From (receipt date)<input type="date" name="from"></label><label>To<input type="date" name="to"></label></div>
          <label>Status<select name="status"><option value="">All</option><option value="verified">Verified only</option><option value="pending">Pending only</option><option value="rejected">Rejected only</option></select></label>
          <button class="btn btn-primary" type="submit">⬇ Donation entries (one row per receipt)</button>
        </form>
        <div class="stack" style="margin-top:14px">
          <button class="btn" data-dl="/api/admin/export/months.csv">⬇ Month allocations (one row per orphan per month)</button>
          <button class="btn" data-dl="/api/admin/export/orphans.csv">⬇ Orphans</button>
          <button class="btn" data-dl="/api/admin/export/donors.csv">⬇ Donors</button>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="card-head"><h3>Import</h3></div>
        <form class="stack" id="imp-form">
          <label>What are you importing?<select name="kind">
            <option value="payments">Donation entries</option><option value="orphans">Orphans (adds new, updates existing by number)</option><option value="donors">Donors</option></select></label>
          <label>Excel or CSV file<input type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
          <p class="small muted">Download a template: <a href="/api/admin/import/template/payments.csv">entries</a> · <a href="/api/admin/import/template/orphans.csv">orphans</a> · <a href="/api/admin/import/template/donors.csv">donors</a>.
            In entries, list several orphans or months separated by <code>;</code> (e.g. <code>2026-09;2026-10</code>). Rows whose transaction ID already exists are skipped. Donors are matched by phone or email and created if new.
            <br>The foundation's orphan sheet (<code>Code</code>, <code>Orphan's Name</code>, <code>Name</code>, <code>Child Phone</code>, <code>SP Code</code>, <code>Sponsor Name</code>, <code>Sponsor Phone</code>, <code>Sponsor Area</code>) can be imported as it is under <em>Orphans</em>: sponsors become donors and are linked to their orphans.</p>
          <div class="form-error" role="alert"></div>
          <div class="actions" style="justify-content:flex-start"><button class="btn" type="submit" data-mode="dry">Check file (no changes)</button><button class="btn btn-primary" type="button" id="imp-go">Import</button></div>
        </form>
        <div id="imp-out"></div>
      </div>
    </div>`);
  $$('[data-dl]').forEach((b) => { b.onclick = () => download(b.dataset.dl); });
  $('#exp-form').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams(Object.entries(formData(e.target)).filter(([, v]) => v));
    download(`/api/admin/export/payments.csv?${p}`);
  };
  const form = $('#imp-form');
  const run = async (dry) => {
    const fd = new FormData(form);
    const kind = fd.get('kind');
    fd.delete('kind');
    fd.append('dry_run', dry ? '1' : '0');
    const r = await api.post(`/api/admin/import/${kind}`, fd);
    $('#imp-out').innerHTML = String(html`
      <div class="alert ${r.errors.length ? 'alert-warn' : 'alert-ok'}" style="margin-top:14px">
        <strong>${r.dry_run ? 'Check result (nothing saved yet)' : 'Import finished'}:</strong>
        ${r.total} rows · ${r.created} ${r.dry_run ? 'will be created' : 'created'} · ${r.updated} ${r.dry_run ? 'will be updated' : 'updated'} · ${r.skipped} skipped · ${r.errors.length} errors
        ${r.kind === 'orphans' && (r.sponsors_linked || r.donors_created) ? html`<br>Sponsors: ${r.sponsors_linked} orphans ${r.dry_run ? 'will be' : ''} linked to a donor · ${r.donors_created} new donor accounts · ${r.no_sponsor} orphans without a sponsor` : ''}
      </div>
      ${r.errors.length ? html`<div class="table-wrap"><table><thead><tr><th>Row</th><th>Problem</th></tr></thead><tbody>${r.errors.map((e) => html`<tr><td>${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div>` : ''}
      ${r.skipped_rows?.length ? html`<details style="margin-top:10px"><summary class="small">Skipped rows (${r.skipped_rows.length})</summary><div class="table-wrap"><table><thead><tr><th>Row</th><th>Why</th></tr></thead><tbody>${r.skipped_rows.map((x) => html`<tr><td>${x.row}</td><td>${x.reason}</td></tr>`)}</tbody></table></div></details>` : ''}`);
    if (!r.dry_run) toast('Import complete');
  };
  onSubmit(form, () => run(true));
  $('#imp-go').onclick = async () => {
    if (!form.file.files.length) { toast('Choose an Excel or CSV file first', 'error'); return; }
    if (!(await confirmDialog('Import this file now? Rows with errors will be skipped.', { okLabel: 'Import' }))) return;
    try { await run(false); } catch (e) { toast(e.message, 'error'); }
  };
};

// ---- Settings ------------------------------------------------------------------

PAGES.settings = async (view) => {
  const [{ settings: s }, { admins }] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/admins')]);
  view.innerHTML = String(html`
    <div class="page-head"><div class="grow"><h1>Settings</h1></div></div>
    <form id="set-form" class="stack">
      <div class="card">
        <div class="card-head"><h3>Foundation accounts</h3><span class="muted small">Donations paid into any other account are flagged for review</span></div>
        <div id="accts" class="stack"></div>
        <button type="button" class="btn btn-sm" id="add-acct" style="margin-top:10px">＋ Add account</button>
      </div>
      <div class="card">
        <div class="card-head"><h3>General</h3></div>
        <div class="form-grid">
          <label>Foundation name<input name="foundationName" value="${s.foundationName}"></label>
          <label>Currency<input name="currency" value="${s.currency}"></label>
          <label>Time zone <span class="hint">decides what "current month" means</span><input name="timezone" value="${s.timezone}"></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="allowDonorRegistration" ${s.allowDonorRegistration ? 'checked' : ''}>Donors can register themselves</label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Receipt rules</h3></div>
        <div class="form-grid">
          <label class="check full"><input type="checkbox" name="requireReceiptDateInCurrentMonth" ${s.requireReceiptDateInCurrentMonth ? 'checked' : ''}>Accept only receipts dated in the current month</label>
          <label class="check full"><input type="checkbox" name="rejectWhenOcrDatesOutsideMonth" ${s.rejectWhenOcrDatesOutsideMonth ? 'checked' : ''}>Reject when the date on the receipt image is not in the current month</label>
          <label>Minimum text clarity (%) <span class="hint">OCR confidence, 0–100</span><input type="number" name="minOcrConfidence" value="${s.minOcrConfidence}" min="0" max="100"></label>
          <label>Minimum sharpness <span class="hint">blur detection; lower = more lenient</span><input type="number" name="minSharpness" value="${s.minSharpness}" min="0"></label>
          <label>Minimum image size (px, shortest side)<input type="number" name="minImageSide" value="${s.minImageSide}" min="0"></label>
          <label>Maximum upload size (MB)<input type="number" name="maxUploadMb" value="${s.maxUploadMb}" min="1" max="25"></label>
          <label>Advance months allowed<input type="number" name="maxAdvanceMonths" value="${s.maxAdvanceMonths}" min="0" max="36"></label>
          <label>Arrears months allowed<input type="number" name="maxArrearsMonths" value="${s.maxArrearsMonths}" min="0" max="24"></label>
        </div>
      </div>
      <div class="form-error" role="alert"></div>
      <div class="actions" style="justify-content:flex-start"><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>
    <div class="card">
      <div class="card-head"><h3>Management users</h3><button class="btn btn-sm" id="add-admin">＋ Add user</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Since</th><th>Status</th><th></th></tr></thead>
        <tbody>${admins.map((a) => html`<tr><td>${a.name}</td><td>${a.email}</td><td>${fmtDate(a.created_at)}</td>
          <td><span class="badge ${a.active ? 'badge-ok' : 'badge-muted'}">${a.active ? 'active' : 'disabled'}</span></td>
          <td>${a.id === me.id ? html`<span class="muted small">you</span>` : html`<button class="btn btn-sm" data-toggle="${a.id}" data-active="${a.active ? 1 : 0}">${a.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`)}</tbody></table></div>
    </div>`);

  const accts = $('#accts');
  const addRow = (a = {}) => {
    const row = document.createElement('div');
    row.className = 'form-grid acct';
    row.style.gridTemplateColumns = '1fr 1fr 1.3fr auto';
    row.innerHTML = String(html`<label>Account title<input data-k="title" value="${a.title || ''}"></label><label>Bank<input data-k="bank" value="${a.bank || ''}"></label>
      <label>Account no. / IBAN<input data-k="account" class="mono" value="${a.account || ''}"></label><button type="button" class="icon-btn" style="align-self:end" aria-label="Remove">✕</button>`);
    $('button', row).onclick = () => row.remove();
    accts.append(row);
  };
  (s.officialAccounts.length ? s.officialAccounts : [{}]).forEach(addRow);
  $('#add-acct').onclick = () => addRow();

  onSubmit($('#set-form'), async (e) => {
    const f = e.target;
    const body = formData(f);
    for (const k of ['allowDonorRegistration', 'requireReceiptDateInCurrentMonth', 'rejectWhenOcrDatesOutsideMonth']) body[k] = f[k].checked;
    body.officialAccounts = $$('.acct', accts).map((row) => Object.fromEntries($$('input', row).map((i) => [i.dataset.k, i.value]))).filter((a) => a.account.trim());
    await api.put('/api/admin/settings', body);
    Object.assign(cfg, await api.get('/api/config'));
    toast('Settings saved');
    route();
  });
  $('#add-admin').onclick = () => {
    const m = modal('Add management user', html`<form class="stack">
      <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
      <label>Password<input name="password" type="text" minlength="6" required></label>
      <div class="form-error" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create</button></div></form>`);
    onSubmit($('form', m.el), async (e) => { await api.post('/api/admin/admins', formData(e.target)); m.close(); toast('User created'); route(); });
  };
  $$('[data-toggle]').forEach((b) => {
    b.onclick = async () => { await api.put(`/api/admin/admins/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }); route(); };
  });
};

// ---- Audit ----------------------------------------------------------------------

PAGES.audit = async (view) => {
  const { entries } = await api.get('/api/admin/audit');
  view.innerHTML = String(html`
    <div class="page-head"><div class="grow"><h1>Activity log</h1><p class="muted">Last 300 actions</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
      <tbody>${entries.map((a) => html`<tr><td class="nowrap small">${a.created_at}</td><td>${a.user_name || ''}</td><td><span class="badge badge-muted">${a.action}</span></td>
        <td>${a.entity ? `${a.entity} #${a.entity_id ?? ''}` : ''}</td><td class="small mono" style="max-width:420px;word-break:break-word">${a.details || ''}</td></tr>`)}</tbody></table></div>`);
};

start().catch((e) => { root.innerHTML = String(html`<div class="container"><div class="alert alert-danger">${e.message}</div></div>`); });
