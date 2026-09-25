// Shared browser helpers for the donor and management portals.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);

/** Tagged template that HTML-escapes every interpolation except raw() values and arrays of them. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else out += v instanceof Raw ? v.s : esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
api.get = (u) => api('GET', u);
api.post = (u, b) => api('POST', u, b ?? {});
api.put = (u, b) => api('PUT', u, b);
api.del = (u) => api('DELETE', u);

let config = null;
export async function getConfig() {
  if (!config) config = await api.get('/api/config');
  return config;
}

export function money(n, currency) {
  const cur = currency ?? config?.currency ?? 'PKR';
  const v = Number(n || 0);
  return `${cur} ${v.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtMonth(m) {
  if (!m) return '';
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtMonths(list) {
  if (!list?.length) return '';
  if (list.length <= 3) return list.map(fmtMonth).join(', ');
  return `${fmtMonth(list[0])} – ${fmtMonth(list.at(-1))} (${list.length} months)`;
}

export function statusBadge(status) {
  const label = { pending: 'Pending review', verified: 'Verified', rejected: 'Rejected' }[status] || status;
  return html`<span class="badge badge-${status}">${label}</span>`;
}

export function toast(message, kind = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.classList.add('hide'), 3800);
  setTimeout(() => el.remove(), 4300);
}

/** Open a modal dialog. Returns { el, close }. */
export function modal(title, bodyHtml, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = String(html`
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${raw(String(bodyHtml))}</div>
    </div>`);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { el: wrap, close };
}

export function confirmDialog(message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal('Please confirm', html`<p>${message}</p>
      <div class="actions"><button class="btn" data-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${okLabel}</button></div>`, { onClose: () => resolve(false) });
    $('[data-ok]', m.el).onclick = () => { resolve(true); m.close(); };
  });
}

export function promptDialog(title, label, { required = true, okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const m = modal(title, html`<form class="stack"><label>${label}<textarea name="v" rows="3" ${required ? 'required' : ''}></textarea></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">${okLabel}</button></div></form>`,
    { onClose: () => resolve(null) });
    const f = $('form', m.el);
    f.v.focus();
    // Resolve before closing: closing runs onClose, which would otherwise resolve null first and drop the text.
    f.onsubmit = (e) => { e.preventDefault(); const v = f.v.value.trim(); resolve(v); m.close(); };
  });
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/** Wrap an async submit handler: disables the button and reports errors in the form. */
export function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit], button:not([type])');
    const errBox = form.querySelector('.form-error');
    if (errBox) errBox.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await fn(e);
    } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.scrollIntoView({ block: 'nearest' }); } else toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Login / registration screen shared by both portals. */
export function renderAuth(root, { role, title, subtitle, allowRegister, onSignedIn }) {
  const showLogin = () => {
    root.innerHTML = String(html`
      <div class="auth-wrap">
        <div class="auth-card">
          <a href="/" class="brand brand-lg"><span class="brand-mark">ب</span><span>${config?.foundationName || 'Bait ul Aqba'}</span></a>
          <h2>${title}</h2>
          <p class="muted">${subtitle}</p>
          <form class="stack" id="login-form">
            <label>${role === 'admin' ? 'Email' : 'Mobile number (03…) or username'}<input name="login" required autocomplete="username" ${role === 'admin' ? '' : 'placeholder="03xx xxxxxxx"'}></label>
            <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
            ${role === 'admin' ? '' : html`<p class="hint">First time? Your password is <strong>bua-</strong> followed by your orphan code, e.g. <span class="mono">bua-or001</span>. Donors outside Pakistan use their first name as username.</p>`}
            <div class="form-error" role="alert"></div>
            <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          </form>
          ${allowRegister ? html`<p class="center muted">New donor? <a href="#" id="to-register">Create an account</a></p>` : ''}
          <p class="center small"><a href="/">← Back to home</a></p>
        </div>
      </div>`);
    onSubmit($('#login-form', root), async (e) => {
      const { user } = await api.post('/api/auth/login', { ...formData(e.target), role });
      onSignedIn(user);
    });
    const reg = $('#to-register', root);
    if (reg) reg.onclick = (e) => { e.preventDefault(); showRegister(); };
  };
  const showRegister = () => {
    root.innerHTML = String(html`
      <div class="auth-wrap">
        <div class="auth-card">
          <a href="/" class="brand brand-lg"><span class="brand-mark">ب</span><span>${config?.foundationName || 'Bait ul Aqba'}</span></a>
          <h2>Create donor account</h2>
          <p class="muted">Register once, then submit your monthly donation receipts. Already sponsoring an orphan? Use the phone number the foundation has for you and your orphans will appear automatically.</p>
          <form class="stack" id="reg-form">
            <label>Full name<input name="name" required autocomplete="name"></label>
            <label>Phone number<input name="phone" inputmode="tel" autocomplete="tel" placeholder="03xx xxxxxxx"></label>
            <label>Email (optional)<input name="email" type="email" autocomplete="email"></label>
            <label>City<input name="city"></label>
            <label>Password<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
            <div class="form-error" role="alert"></div>
            <button class="btn btn-primary btn-block" type="submit">Create account</button>
          </form>
          <p class="center muted">Already registered? <a href="#" id="to-login">Sign in</a></p>
        </div>
      </div>`);
    onSubmit($('#reg-form', root), async (e) => {
      const { user } = await api.post('/api/auth/register', formData(e.target));
      onSignedIn(user);
    });
    $('#to-login', root).onclick = (e) => { e.preventDefault(); showLogin(); };
  };
  showLogin();
}

export async function signOut() {
  await api.post('/api/auth/logout');
  location.reload();
}

export function changePasswordDialog(onChanged) {
  const m = modal('Change password', html`
    <form class="stack">
      <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
      <label>New password<input type="password" name="next" minlength="6" required autocomplete="new-password"></label>
      <div class="form-error" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Update password</button></div>
    </form>`);
  onSubmit($('form', m.el), async (e) => {
    await api.post('/api/auth/password', formData(e.target));
    m.close();
    toast('Password updated');
    onChanged?.();
  });
}
