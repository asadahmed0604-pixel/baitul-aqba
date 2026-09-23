import {
  api, html, raw, $, $$, getConfig, money, fmtDate, fmtMonth, fmtMonths, statusBadge, toast, modal,
  renderAuth, signOut, changePasswordDialog, onSubmit, download,
} from '/js/common.js';
import { scanReceipt } from '/js/receipt-scan.js';
import { addMonths, monthOf, parseDates } from '/shared/receipt-parser.js';

const root = $('#app');
let cfg, me;

async function start() {
  cfg = await getConfig();
  document.title = `Donor Portal · ${cfg.foundationName}`;
  const { user } = await api.get('/api/auth/me');
  if (!user || user.role !== 'donor') {
    renderAuth(root, {
      role: 'donor', title: 'Donor sign in', subtitle: 'Sign in to submit your donation receipts.',
      allowRegister: cfg.allowDonorRegistration, onSignedIn: (u) => { me = u; shell(); },
    });
    return;
  }
  me = user;
  shell();
}

function shell() {
  root.innerHTML = String(html`
    <header class="topbar">
      <a class="brand" href="/donor"><span class="brand-mark">ب</span><span>${cfg.foundationName}</span></a>
      <span class="badge badge-info">Donor</span>
      <span class="spacer"></span>
      <span class="muted small hide-sm">${me.name}</span>
      <button class="btn btn-sm" id="pw">Password</button>
      <button class="btn btn-sm" id="logout">Sign out</button>
    </header>
    <main class="container" id="view"></main>`);
  $('#logout').onclick = signOut;
  $('#pw').onclick = changePasswordDialog;
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  if (location.hash === '#new') return newEntry();
  return dashboard();
}

// ---- Dashboard -------------------------------------------------------------

async function dashboard() {
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  const [{ orphans, month }, { payments }] = await Promise.all([api.get('/api/donor/orphans'), api.get('/api/donor/payments')]);
  const total = payments.filter((p) => p.status === 'verified').reduce((s, p) => s + p.amount, 0);
  const pending = payments.filter((p) => p.status === 'pending').length;
  const thisMonthPaid = orphans.filter((o) => o.months.some((m) => m.month === month)).length;

  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow">
        <h1>Assalam-o-Alaikum, ${me.name.split(' ')[0]}</h1>
        <p class="muted">Thank you for supporting our orphans. Today is ${fmtDate(cfg.today)}.</p>
      </div>
      <a class="btn btn-primary" href="#new">＋ New donation entry</a>
    </div>

    <div class="grid grid-3">
      <div class="card stat accent"><div class="label">Verified donations</div><div class="value">${money(total)}</div><div class="sub">all time</div></div>
      <div class="card stat warn"><div class="label">Awaiting review</div><div class="value">${pending}</div><div class="sub">entries</div></div>
      <div class="card stat"><div class="label">${cfg.monthLabel}</div><div class="value">${thisMonthPaid} / ${orphans.length}</div><div class="sub">of your orphans paid for this month</div></div>
    </div>

    ${cfg.officialAccounts.length ? html`
      <div class="card">
        <div class="card-head"><h3>Foundation accounts</h3><span class="muted small">Please pay only into these accounts</span></div>
        <div class="accounts">${cfg.officialAccounts.map((a) => html`
          <div class="account-item"><div class="grow"><strong>${a.title}</strong><div class="muted small">${a.bank}</div></div><span class="mono">${a.account}</span></div>`)}
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>My orphans</h3></div>
      ${orphans.length ? html`<div class="grid grid-2">${orphans.map((o) => orphanCard(o, month))}</div>`
        : html`<p class="muted">No orphans are linked to your account yet. When you submit your first donation with an orphan number, it will appear here.</p>`}
      <div class="legend" style="margin-top:12px"><span><i style="background:var(--ok)"></i>Verified</span><span><i style="background:var(--accent)"></i>Pending review</span><span><i style="background:var(--border)"></i>Not paid</span></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>My donation entries</h3><button class="btn btn-sm" id="export">⬇ Export (Excel/CSV)</button></div>
      ${payments.length ? html`
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Receipt date</th><th>Orphan(s)</th><th>For months</th><th class="num">Amount</th><th>Paid to</th><th>Status</th></tr></thead>
          <tbody>${payments.map((p) => html`
            <tr class="clickable" data-id="${p.id}">
              <td>${p.id}</td><td class="nowrap">${fmtDate(p.payment_date)}</td><td>${p.orphan_nos.join(', ')}</td>
              <td>${fmtMonths(p.months)}</td><td class="num">${money(p.amount)}</td>
              <td>${p.beneficiary_name || ''}<div class="muted small mono">${p.beneficiary_account || ''}</div></td>
              <td>${statusBadge(p.status)}${p.status === 'rejected' && p.admin_note ? html`<div class="small" style="color:var(--danger)">${p.admin_note}</div>` : ''}</td>
            </tr>`)}
          </tbody></table></div>`
        : html`<div class="empty">No entries yet. <a href="#new">Submit your first donation</a>.</div>`}
    </div>`);

  $('#export')?.addEventListener('click', () => download('/api/donor/export.csv'));
  $$('tr[data-id]', view).forEach((tr) => {
    tr.onclick = () => showEntry(payments.find((p) => p.id === Number(tr.dataset.id)));
  });
}

function orphanCard(o, month) {
  const cells = [];
  for (let i = -5; i <= 6; i++) {
    const m = addMonths(month, i);
    const hits = o.months.filter((x) => x.month === m);
    const cls = hits.some((h) => h.status === 'verified') ? 'v' : hits.length ? 'p' : '';
    cells.push(html`<i class="${cls} ${m === month ? 'cur' : ''}" title="${fmtMonth(m)}">${fmtMonth(m).slice(0, 3)}</i>`);
  }
  return html`
    <div class="card" style="margin:0">
      <div class="card-head" style="margin-bottom:4px"><h3>${o.name}</h3><span class="badge badge-muted mono">${o.orphan_no}</span></div>
      <div class="muted small">${o.monthly_amount ? `Monthly sponsorship: ${money(o.monthly_amount)}` : ''}
        ${o.monthly_amount ? ' · ' : ''}${o.paid_through ? html`Paid through <strong>${fmtMonth(o.paid_through)}</strong>` : html`<span style="color:var(--danger)">${fmtMonth(month)} not yet paid</span>`}</div>
      <div class="strip">${cells}</div>
    </div>`;
}

function showEntry(p) {
  modal(`Entry #${p.id}`, html`
    <p>${statusBadge(p.status)} <span class="muted small">submitted ${fmtDate(p.submitted_at)}</span></p>
    ${p.status === 'rejected' ? html`<div class="alert alert-danger"><strong>Reason:</strong> ${p.admin_note || 'Not given'}</div>` : ''}
    <dl class="kv">
      <dt>Receipt date</dt><dd>${fmtDate(p.payment_date)}</dd>
      <dt>Amount</dt><dd>${money(p.amount)}</dd>
      <dt>Allocation</dt><dd>${p.allocations.map((a) => html`<div>${a.orphan_no} · ${fmtMonth(a.month)} · ${money(a.amount)}</div>`)}</dd>
      <dt>Bank</dt><dd>${p.bank_name}</dd>
      <dt>Transaction ID</dt><dd class="mono">${p.transaction_ref}</dd>
      <dt>Paid to</dt><dd>${p.beneficiary_name}<div class="mono small">${p.beneficiary_account}</div>${p.beneficiary_bank}</dd>
      ${p.donor_note ? html`<dt>Your note</dt><dd>${p.donor_note}</dd>` : ''}
    </dl>
    ${p.has_image ? html`<p style="margin-top:14px"><img class="receipt-img-lg" src="/api/payments/${p.id}/image" alt="Receipt"></p>` : ''}`);
}

// ---- New entry ---------------------------------------------------------------

async function newEntry() {
  const view = $('#view');
  const { orphans, month } = await api.get('/api/donor/orphans');
  const state = { file: null, scan: null };
  const monthOptions = [];
  for (let i = -cfg.maxArrearsMonths; i <= cfg.maxAdvanceMonths; i++) monthOptions.push(addMonths(month, i));

  view.innerHTML = String(html`
    <div class="page-head">
      <div class="grow"><h1>New donation entry</h1>
        <p class="muted">Upload the bank receipt for a payment made in <strong>${cfg.monthLabel}</strong>. Only clear receipts dated in the current month are accepted.</p></div>
      <a class="btn" href="#">← Back</a>
    </div>

    <form id="entry" class="stack" novalidate>
      <div class="card">
        <div class="card-head"><h3>1. Bank receipt</h3><span class="muted small">Screenshot or clear photo · JPG / PNG · max ${cfg.maxUploadMb} MB</span></div>
        <label class="dropzone" id="drop">
          <input type="file" id="file" accept="image/jpeg,image/png,image/webp">
          <div><strong>Tap to choose your receipt</strong> or drag it here</div>
          <div class="muted small">It must clearly show the date, amount, beneficiary account and transaction ID</div>
        </label>
        <div id="scan" class="hidden" style="margin-top:14px"></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>2. Receipt details</h3><span class="muted small">Filled in from the receipt. Check and correct if needed.</span></div>
        <div class="form-grid">
          <label>Date on receipt<input type="date" name="payment_date" required min="${month}-01" max="${cfg.today}" value=""></label>
          <label>Amount paid (${cfg.currency})<input name="amount" inputmode="decimal" required placeholder="e.g. 5000"></label>
          <label>Transaction ID / reference<input name="transaction_ref" placeholder="As printed on the receipt"></label>
          <label>Paid from bank / wallet<input name="bank_name" placeholder="e.g. Meezan Bank, JazzCash"></label>
          <label>Beneficiary name (paid to)<input name="beneficiary_name"></label>
          <label>Beneficiary account / IBAN<input name="beneficiary_account" class="mono"></label>
          <label>Beneficiary bank<input name="beneficiary_bank"></label>
          <label>Sender name<input name="sender_name" value="${me.name}"></label>
          <label class="full">Receipt text <span class="hint">(read automatically; you can type or correct it)</span>
            <textarea name="receipt_text" rows="4" placeholder="Text from the receipt"></textarea></label>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>3. Orphan(s)</h3><span class="muted small">Which orphan number(s) is this payment for?</span></div>
        <div class="chips" id="orphan-chips">${orphans.map((o) => html`
          <label class="chip"><input type="checkbox" name="orphan" value="${o.orphan_no}" ${orphans.length === 1 ? 'checked' : ''}>${o.orphan_no} · ${o.name}</label>`)}
        </div>
        <div class="form-grid" style="margin-top:12px">
          <label>Add another orphan number<input id="orphan-add" placeholder="e.g. BUA-001" autocomplete="off"></label>
          <div style="align-self:end"><button type="button" class="btn" id="orphan-add-btn">Add</button> <span id="orphan-msg" class="small"></span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>4. Month(s) covered</h3><span class="muted small">Select several months if you are paying in advance</span></div>
        <div class="months">${monthOptions.map((m) => html`
          <label class="month-chip"><input type="checkbox" name="month" value="${m}" ${m === month ? 'checked' : ''}>
            <span>${fmtMonth(m)}<small>${m === month ? 'Current' : m > month ? 'Advance' : 'Arrears'}</small></span></label>`)}
        </div>
        <div id="split" class="muted small" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <label>Note for the foundation (optional)<textarea name="donor_note" rows="2"></textarea></label>
        <div class="form-error" role="alert" style="margin-top:12px"></div>
        <div class="actions"><a class="btn" href="#">Cancel</a><button class="btn btn-primary" type="submit" id="submit">Submit entry</button></div>
      </div>
    </form>`);

  const form = $('#entry');
  const fileInput = $('#file');
  const drop = $('#drop');

  const updateSplit = () => {
    const nos = $$('input[name=orphan]:checked', form).map((i) => i.value);
    const ms = $$('input[name=month]:checked', form).map((i) => i.value);
    const amt = Number(String(form.amount.value).replace(/,/g, '')) || 0;
    const n = nos.length * ms.length;
    $('#split').innerHTML = String(n && amt
      ? html`<strong>${money(amt)}</strong> will be recorded as ${n} month entr${n === 1 ? 'y' : 'ies'} of about <strong>${money(Math.round((amt / n) * 100) / 100)}</strong> each (${nos.join(', ')} × ${fmtMonths(ms)}).`
      : html`Select orphan(s), month(s) and enter the amount to see how the payment will be recorded.`);
  };
  form.addEventListener('input', updateSplit);
  form.addEventListener('change', updateSplit);
  updateSplit();

  // Orphan lookup
  const addOrphan = async () => {
    const no = $('#orphan-add').value.trim().toUpperCase();
    const msg = $('#orphan-msg');
    if (!no) return;
    if ($$('input[name=orphan]', form).some((i) => i.value.toUpperCase() === no)) {
      $$('input[name=orphan]', form).find((i) => i.value.toUpperCase() === no).checked = true;
      $('#orphan-add').value = '';
      updateSplit();
      return;
    }
    try {
      const o = await api.get(`/api/donor/orphan-lookup/${encodeURIComponent(no)}`);
      const chip = document.createElement('label');
      chip.className = 'chip';
      chip.innerHTML = String(html`<input type="checkbox" name="orphan" value="${o.orphan_no}" checked>${o.orphan_no} · ${o.name}`);
      $('#orphan-chips').append(chip);
      $('#orphan-add').value = '';
      msg.textContent = '';
      updateSplit();
    } catch (e) {
      msg.textContent = e.message;
      msg.style.color = 'var(--danger)';
    }
  };
  $('#orphan-add-btn').onclick = addOrphan;
  $('#orphan-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOrphan(); } });

  // Receipt handling
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.onchange = () => fileInput.files[0] && handleFile(fileInput.files[0]);

  async function handleFile(file) {
    const box = $('#scan');
    box.classList.remove('hidden');
    state.file = null;
    state.scan = null;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      box.innerHTML = String(html`<div class="alert alert-danger">Please upload a JPG, PNG or WebP image of the receipt (PDF is not accepted).</div>`);
      return;
    }
    if (file.size > cfg.maxUploadMb * 1024 * 1024) {
      box.innerHTML = String(html`<div class="alert alert-danger">The image is larger than ${cfg.maxUploadMb} MB. Please upload a smaller screenshot.</div>`);
      return;
    }
    const url = URL.createObjectURL(file);
    box.innerHTML = String(html`
      <div class="receipt-preview">
        <img src="${url}" alt="Receipt preview">
        <div><strong id="scan-status">Checking receipt…</strong><div class="progress"><div id="scan-bar"></div></div>
          <ul class="checks" id="checks" style="margin-top:10px"></ul></div>
      </div>`);
    $('#submit').disabled = true;
    try {
      const scan = await scanReceipt(file, {
        onProgress: (label, p) => { $('#scan-status').textContent = label; $('#scan-bar').style.width = `${Math.round(p * 100)}%`; },
      });
      state.scan = scan;
      state.file = file;
      applyScan(scan);
    } catch (e) {
      $('#scan-status').textContent = e.message;
    } finally {
      $('#submit').disabled = false;
    }
  }

  function applyScan(scan) {
    const p = scan.parsed;
    const set = (name, v) => { if (v) form[name].value = v; };
    set('payment_date', p.paymentDate);
    set('amount', p.amount ? String(p.amount) : '');
    set('transaction_ref', p.transactionRef);
    set('bank_name', p.banks[0]);
    set('beneficiary_name', p.beneficiaryName);
    set('beneficiary_account', p.beneficiaryAccount);
    set('beneficiary_bank', p.beneficiaryBank);
    if (scan.ocrText) form.receipt_text.value = scan.ocrText.trim();
    $('#scan-status').textContent = 'Receipt checked';
    $('#scan-bar').style.width = '100%';
    renderChecks();
    updateSplit();
  }

  function renderChecks() {
    const scan = state.scan;
    if (!scan) return;
    const checks = [];
    const add = (cls, text) => checks.push(html`<li class="${cls}"><span class="ic">${cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : '!'}</span><span>${text}</span></li>`);
    const minSide = Math.min(scan.width, scan.height);
    add(minSide >= cfg.minImageSide ? 'ok' : 'bad', minSide >= cfg.minImageSide ? `Image size OK (${scan.width}×${scan.height})` : `Image is too small (${scan.width}×${scan.height}). Upload the full-size screenshot.`);
    add(scan.sharpness >= cfg.minSharpness ? 'ok' : 'bad', scan.sharpness >= cfg.minSharpness ? 'Image is sharp' : 'Image looks blurry. Please upload a clearer photo or screenshot.');
    if (scan.ocrError) {
      add('warn', `Automatic reading unavailable (${scan.ocrError}). Please type the details yourself; management will check the image.`);
    } else {
      add(scan.confidence >= cfg.minOcrConfidence ? 'ok' : 'bad', scan.confidence >= cfg.minOcrConfidence ? `Text is readable (clarity ${scan.confidence}%)` : `Text is not clear (clarity ${scan.confidence}%). Please upload a clearer image.`);
      const dates = parseDates(scan.ocrText).map((d) => d.iso);
      const cur = dates.filter((d) => monthOf(d) === cfg.month);
      if (!dates.length) add('warn', 'No date found on the receipt. Enter the date shown on the receipt below.');
      else if (cur.length) add('ok', `Receipt date ${fmtDate(cur[0])} is in ${cfg.monthLabel}`);
      else add('bad', `Receipt shows ${dates.map(fmtDate).join(', ')}. Only receipts from ${cfg.monthLabel} are accepted.`);
      add(scan.parsed.beneficiaryAccount || scan.parsed.beneficiaryName ? 'ok' : 'warn',
        scan.parsed.beneficiaryAccount || scan.parsed.beneficiaryName
          ? `Beneficiary found: ${[scan.parsed.beneficiaryName, scan.parsed.beneficiaryAccount].filter(Boolean).join(' · ')}`
          : 'Beneficiary account not found. Please enter who the payment was made to.');
      add(scan.parsed.transactionRef ? 'ok' : 'warn', scan.parsed.transactionRef ? `Transaction ID: ${scan.parsed.transactionRef}` : 'Transaction ID not found. Please enter it if shown.');
    }
    $('#checks').innerHTML = String(html`${checks}`);
  }

  onSubmit(form, async () => {
    const err = (m) => { throw new Error(m); };
    if (!state.file) err('Please attach the bank receipt image');
    const nos = $$('input[name=orphan]:checked', form).map((i) => i.value);
    const ms = $$('input[name=month]:checked', form).map((i) => i.value);
    if (!nos.length) err('Select at least one orphan');
    if (!ms.length) err('Select at least one month');
    if (!form.payment_date.value) err('Enter the date shown on the receipt');
    if (monthOf(form.payment_date.value) !== cfg.month) err(`Only receipts dated in ${cfg.monthLabel} are accepted`);
    if (!(Number(String(form.amount.value).replace(/,/g, '')) > 0)) err('Enter the amount paid');

    const fd = new FormData();
    for (const name of ['payment_date', 'amount', 'transaction_ref', 'bank_name', 'beneficiary_name', 'beneficiary_account', 'beneficiary_bank', 'sender_name', 'receipt_text', 'donor_note']) {
      fd.append(name, form[name].value);
    }
    fd.append('orphan_nos', JSON.stringify(nos));
    fd.append('months', JSON.stringify(ms));
    fd.append('receipt', state.file, state.file.name);
    if (state.scan) {
      fd.append('sharpness', state.scan.sharpness);
      if (!state.scan.ocrError) {
        fd.append('ocr_text', state.scan.ocrText);
        fd.append('ocr_confidence', state.scan.confidence);
      }
    }
    const { payment } = await api.post('/api/donor/payments', fd);
    const warn = payment.flags.filter((f) => ['unknown_beneficiary_account', 'month_already_covered', 'amount_mismatch', 'date_mismatch'].includes(f.code));
    location.hash = '';
    toast(`Entry #${payment.id} submitted. It will be verified by the foundation.`);
    if (warn.length) {
      modal('Submitted, with notes', html`<p>Your entry #${payment.id} has been submitted for review. Please note:</p>
        <ul class="flag-list">${warn.map((f) => html`<li>${f.message}</li>`)}</ul>
        <div class="actions"><button class="btn btn-primary" data-close>OK</button></div>`);
    }
  });
}

start().catch((e) => { root.innerHTML = String(html`<div class="container"><div class="alert alert-danger">${e.message}</div></div>`); });
