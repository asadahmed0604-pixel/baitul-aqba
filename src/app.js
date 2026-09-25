import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Router, HttpError, fail, sendJson, sendFile, readBody, parseMultipart, serveStatic,
} from './http.js';
import { openDb, getSettings, saveSettings, audit, tx, DEFAULT_SETTINGS } from './db.js';
import { createAuth, hashPassword, verifyPassword, loadSecret, checkLoginRate, resetLoginRate } from './auth.js';
import {
  createPayment, getPayment, updatePayment, setStatus, deletePayment, decorate, clock, parseList, normalizeMonth,
} from './payments.js';
import { weeklyReport, coverageReport, beneficiaryReport, paymentsInRange } from './reports.js';
import { toCsv, parseCsv } from './csv.js';
import { parseXlsx, isXlsx } from './xlsx.js';
import { issueLogin, makeUsername, validUsername, localPkMobile } from './logins.js';
import { registerBatchRoutes, batchSummary } from './batches.js';
import { orphanLedger, donorLedger, LEDGER_COLUMNS } from './ledgers.js';
import { addMonths, monthLabel, normalizeAccount, daysInMonth } from '../public/shared/receipt-parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PAYMENT_COLUMNS = [
  { key: 'id', label: 'entry_id' },
  { key: 'donor_name', label: 'donor_name' },
  { key: 'donor_phone', label: 'donor_phone' },
  { key: 'donor_email', label: 'donor_email' },
  { label: 'orphan_nos', value: (p) => p.orphan_nos.join(';') },
  { label: 'months', value: (p) => p.months.join(';') },
  { key: 'amount', label: 'amount' },
  { key: 'payment_date', label: 'payment_date' },
  { key: 'bank_name', label: 'bank_name' },
  { key: 'transaction_ref', label: 'transaction_ref' },
  { key: 'sender_name', label: 'sender_name' },
  { key: 'sender_account', label: 'sender_account' },
  { key: 'beneficiary_name', label: 'beneficiary_name' },
  { key: 'beneficiary_account', label: 'beneficiary_account' },
  { key: 'beneficiary_bank', label: 'beneficiary_bank' },
  { key: 'status', label: 'status' },
  { key: 'source', label: 'source' },
  { label: 'flags', value: (p) => p.flags.map((f) => f.code).join(';') },
  { key: 'donor_note', label: 'donor_note' },
  { key: 'admin_note', label: 'admin_note' },
  { key: 'submitted_at', label: 'submitted_at' },
  { key: 'reviewed_at', label: 'reviewed_at' },
  { key: 'receipt_text', label: 'receipt_text' },
];

const ORPHAN_COLUMNS = ['orphan_no', 'name', 'name_ar', 'child_phone', 'guardian_name', 'date_of_birth', 'city', 'monthly_amount', 'status', 'notes']
  .map((k) => ({ key: k, label: k }));

const TEMPLATES = {
  payments: { columns: PAYMENT_COLUMNS.filter((c) => !['entry_id', 'source', 'flags', 'reviewed_at', 'submitted_at'].includes(c.label)),
    sample: [{ donor_name: 'Ahmed Khan', donor_phone: '03001234567', donor_email: 'ahmed@example.com', orphan_nos: ['BUA-001'], months: ['2026-09', '2026-10'], amount: 10000, payment_date: '2026-09-05', bank_name: 'Meezan Bank', transaction_ref: 'FT123456789', sender_name: 'Ahmed Khan', sender_account: '01010102345678', beneficiary_name: 'Bait ul Aqba Foundation', beneficiary_account: 'PK36MEZN0001230104567890', beneficiary_bank: 'Meezan Bank', status: 'verified', donor_note: '', admin_note: '', receipt_text: '', flags: [] }] },
  orphans: { columns: ORPHAN_COLUMNS, sample: [{ orphan_no: 'BUA-001', name: 'Orphan name', name_ar: '', child_phone: '', guardian_name: 'Guardian name', date_of_birth: '2015-04-12', city: 'Lahore', monthly_amount: 5000, status: 'active', notes: '' }] },
  donors: { columns: ['name', 'phone', 'email', 'city', 'sponsor_code', 'orphan_nos', 'password'].map((k) => ({ key: k, label: k })),
    sample: [{ name: 'Ahmed Khan', phone: '03001234567', email: 'ahmed@example.com', city: 'Karachi', sponsor_code: 'SP11', orphan_nos: 'BUA-001;BUA-002', password: '' }] },
};

// One canonical form per phone number, so "0300 1234567", "92300…" and "+92 300…" are the same login.
export const cleanPhone = (v) => {
  let s = String(v || '').trim().replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  s = s.replace(/(?!^)\+/g, '');
  if (!s.startsWith('+')) {
    if (/^03\d{9}$/.test(s)) s = `+92${s.slice(1)}`;
    else if (/^3\d{9}$/.test(s)) s = `+92${s}`;
    else if (/^92\d{10}$/.test(s)) s = `+${s}`;
  }
  return s.replace(/\D/g, '') ? s : null;
};
// Children's numbers in the orphan sheet are mostly Palestinian (970 / 972) written many ways.
const cleanChildPhone = (v) => {
  let s = String(v || '').trim().replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (/^0(97[02])/.test(s)) s = `+${s.slice(1)}`;
  else if (/^97[02]\d{8,9}$/.test(s)) s = `+${s}`;
  return s || null;
};
const NO_SPONSOR = /^(no\s*sponsor|n\/?a|none|nil|-+)$/i;
const cleanSponsorCode = (v) => {
  const c = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  return c && !NO_SPONSOR.test(c) ? c : null;
};

/** Map the column names people actually use (e.g. the foundation's orphan sheet) onto the importer's fields. */
function applyAliases(kind, row) {
  const r = { ...row };
  const pick = (target, ...keys) => {
    if (r[target] != null && r[target] !== '') return;
    for (const k of keys) if (row[k] != null && row[k] !== '') { r[target] = row[k]; return; }
  };
  if (kind === 'orphans') {
    if ('orphan_s_name' in row || 'orphan_name' in row) {
      // In that layout "Name" holds the Arabic name next to the English "Orphan's Name".
      r.name = row.orphan_s_name || row.orphan_name || '';
      r.name_ar = row.name_ar || row.name || '';
    }
    pick('orphan_no', 'code', 'orphan_code', 'orphan_number', 'orphan_id');
    pick('name_ar', 'arabic_name', 'name_arabic');
    pick('name', 'name_ar');
    pick('child_phone', 'phone', 'orphan_phone', 'contact');
    pick('sponsor_code', 'sp_code', 'sponsor_id');
    pick('sponsor_area', 'sponsor_city');
  }
  if (kind === 'donors') {
    pick('sponsor_code', 'sp_code');
    pick('city', 'area', 'sponsor_area');
  }
  Object.defineProperty(r, '_row', { value: row._row });
  return r;
}
const cleanEmail = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
};

function publicUser(u) {
  return u && {
    id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, city: u.city, username: u.username || null,
    must_change_password: !!u.password_is_default,
  };
}

// English names written consistently: collapse spaces and capitalise words typed in lower case
// ("ahmad ramzi al-saami" -> "Ahmad Ramzi Al-Saami"); words already capitalised are left alone.
export const tidyName = (v) => String(v || '').trim().replace(/\s+/g, ' ')
  .replace(/(^|[\s\-'(])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

// Behind a hosting proxy (Render, Railway, Nginx) the real client address is in X-Forwarded-For.
const clientIp = (req) => (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
  || req.socket.remoteAddress;

export function createApp({ dataDir = path.join(ROOT, 'data'), uploadsDir = path.join(ROOT, 'uploads'), dbFile, secureCookies = false } = {}) {
  const db = openDb(dbFile || path.join(dataDir, 'baitulaqba.db'));
  fs.mkdirSync(uploadsDir, { recursive: true });
  const auth = createAuth(db, loadSecret(dataDir), { secureCookies });
  const r = new Router();
  const settings = () => getSettings(db);

  // ---- Bootstrap first management account --------------------------------
  const adminCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
  let bootstrap = null;
  if (!adminCount) {
    const email = (process.env.ADMIN_EMAIL || 'admin@baitulaqba.org').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    db.prepare(`INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Foundation Admin', ?, ?)`).run(email, hashPassword(password));
    bootstrap = { email, password };
  }

  // ---- Helpers -----------------------------------------------------------
  const findUserByLogin = (login) => {
    const l = String(login || '').trim();
    if (!l) return null;
    const raw = String(l).replace(/[^\d+]/g, '');
    return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(l)
      || db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR phone IN (?, ?)').get(l.toLowerCase(), cleanPhone(l), raw || null);
  };

  function validatePassword(p) {
    if (String(p || '').length < 6) fail(400, 'Password must be at least 6 characters');
  }

  function createDonor({ name, email, phone, city, password, sponsor_code }, actorId, { allowNoLogin = false } = {}) {
    name = String(name || '').trim();
    email = cleanEmail(email);
    phone = cleanPhone(phone);
    if (!name) fail(400, 'Name is required');
    if (!email && !phone && !allowNoLogin) fail(400, 'Enter a phone number or email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address');
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'This email is already registered');
    if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) fail(409, 'This phone number is already registered');
    if (password) validatePassword(password);
    const res = db.prepare(`INSERT INTO users (role, name, email, phone, city, password_hash, sponsor_code) VALUES ('donor', ?, ?, ?, ?, ?, ?)`)
      .run(name, email, phone, String(city || '').trim() || null, password ? hashPassword(password) : null, cleanSponsorCode(sponsor_code));
    const id = Number(res.lastInsertRowid);
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(makeUsername(db, { id, name, phone }), id);
    audit(db, actorId ?? id, 'donor.create', 'user', id, { name });
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  const assignOrphans = (donorId, orphanNos) => {
    const missing = [];
    for (const no of parseList(orphanNos)) {
      const o = db.prepare('SELECT id FROM orphans WHERE orphan_no = ?').get(no);
      if (o) db.prepare('INSERT OR IGNORE INTO donor_orphans (donor_id, orphan_id) VALUES (?, ?)').run(donorId, o.id);
      else missing.push(no);
    }
    return missing;
  };

  const monthParam = (q) => {
    const m = q.get('month') || clock(settings()).month;
    if (!MONTH_RE.test(m)) fail(400, 'month must be YYYY-MM');
    return m;
  };
  const statusesParam = (q) => (q.get('status') ? q.get('status').split(',') : ['verified', 'pending']);
  const csv = (res, name, columns, rows) => sendFile(res, toCsv(columns, rows), { type: 'text/csv; charset=utf-8', filename: name });

  // ---- Public ------------------------------------------------------------
  r.get('/api/config', () => {
    const s = settings();
    const { today, month } = clock(s);
    return {
      foundationName: s.foundationName, currency: s.currency, timezone: s.timezone, today, month,
      monthLabel: monthLabel(month),
      minOcrConfidence: s.minOcrConfidence, minSharpness: s.minSharpness, minImageSide: s.minImageSide,
      maxUploadMb: s.maxUploadMb, maxAdvanceMonths: s.maxAdvanceMonths, maxArrearsMonths: s.maxArrearsMonths,
      allowDonorRegistration: s.allowDonorRegistration,
      officialAccounts: s.officialAccounts,
    };
  });

  r.get('/api/health', () => ({ ok: true }));

  r.post('/api/auth/login', (ctx) => {
    const { login, password, role } = ctx.body;
    const key = `${ctx.ip}:${String(login).toLowerCase()}`;
    checkLoginRate(key);
    const u = findUserByLogin(login);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) fail(401, 'Incorrect login or password');
    if (role && u.role !== role) fail(403, role === 'admin' ? 'This account does not have management access' : 'Please use the management portal to sign in');
    resetLoginRate(key);
    auth.issue(ctx.res, u);
    audit(db, u.id, 'auth.login', 'user', u.id, null);
    return { user: publicUser(u) };
  });

  r.post('/api/auth/register', (ctx) => {
    if (!settings().allowDonorRegistration) fail(403, 'Self registration is disabled. Please contact the foundation.');
    validatePassword(ctx.body.password);
    // Sponsors imported from the orphan sheet already have a donor record (with their orphans linked)
    // but no password yet. Registering with that phone number sets the password on that record.
    const phone = cleanPhone(ctx.body.phone);
    const existing = phone && db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
    if (existing && existing.role === 'donor' && !existing.password_hash && existing.active) {
      const email = cleanEmail(ctx.body.email);
      const emailFree = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
      db.prepare('UPDATE users SET password_hash = ?, email = COALESCE(email, ?), city = COALESCE(city, ?), session_version = session_version + 1 WHERE id = ?')
        .run(hashPassword(ctx.body.password), emailFree ? email : null, String(ctx.body.city || '').trim() || null, existing.id);
      audit(db, existing.id, 'donor.claim', 'user', existing.id, { name: String(ctx.body.name || '').trim() });
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
      auth.issue(ctx.res, u);
      return { user: publicUser(u), claimed: true };
    }
    if (existing && existing.role === 'donor' && existing.password_hash) {
      fail(409, 'This mobile number already has an account. Sign in with your mobile number (03…); your password is bua- followed by your orphan code, e.g. bua-or001 (unless you changed it).');
    }
    const u = createDonor(ctx.body);
    auth.issue(ctx.res, u);
    return { user: publicUser(u) };
  });

  r.post('/api/auth/logout', (ctx) => { auth.clear(ctx.res); return { ok: true }; });
  r.get('/api/auth/me', (ctx) => ({ user: publicUser(ctx.user) }));

  r.post('/api/auth/password', auth.requireUser, (ctx) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyPassword(ctx.body.current, u.password_hash)) fail(400, 'Current password is incorrect');
    validatePassword(ctx.body.next);
    if (ctx.body.next === ctx.body.current) fail(400, 'Choose a new password that is different from the current one');
    db.prepare('UPDATE users SET password_hash = ?, default_password = NULL, password_is_default = 0, session_version = session_version + 1 WHERE id = ?')
      .run(hashPassword(ctx.body.next), u.id);
    auth.issue(ctx.res, db.prepare('SELECT * FROM users WHERE id = ?').get(u.id));
    return { ok: true };
  });

  // Receipt images: owner donor or management only.
  r.get('/api/payments/:id/image', auth.requireUser, (ctx) => {
    const p = db.prepare('SELECT donor_id, image_path FROM payments WHERE id = ?').get(Number(ctx.params.id));
    if (!p || !p.image_path) fail(404, 'No image');
    if (ctx.user.role !== 'admin' && p.donor_id !== ctx.user.id) fail(403, 'Not allowed');
    const file = path.join(uploadsDir, p.image_path);
    const ext = path.extname(file).slice(1);
    sendFile(ctx.res, fs.readFileSync(file), { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, filename: path.basename(file), inline: true });
  });

  // ---- Donor end ---------------------------------------------------------
  r.get('/api/donor/orphans', auth.requireDonor, (ctx) => {
    const { month } = clock(settings());
    const orphans = db.prepare(`
      SELECT o.id, o.orphan_no, o.name, o.monthly_amount, o.status FROM donor_orphans d
      JOIN orphans o ON o.id = d.orphan_id WHERE d.donor_id = ? ORDER BY o.orphan_no`).all(ctx.user.id);
    const months = db.prepare(`
      SELECT pm.month, p.status, SUM(pm.amount) AS amount FROM payment_months pm JOIN payments p ON p.id = pm.payment_id
      WHERE pm.orphan_id = ? AND p.donor_id = ? AND p.status != 'rejected' GROUP BY pm.month, p.status ORDER BY pm.month`);
    return {
      month,
      orphans: orphans.map((o) => {
        const ms = months.all(o.id, ctx.user.id);
        const paidThrough = ms.filter((m) => m.month >= month).map((m) => m.month).sort();
        let through = null;
        for (let cur = month; paidThrough.includes(cur); cur = addMonths(cur, 1)) through = cur;
        return { ...o, months: ms, paid_through: through };
      }),
    };
  });

  r.get('/api/donor/notifications', auth.requireDonor, (ctx) => ({
    notifications: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.user.id).n,
  }));
  r.post('/api/donor/notifications/read', auth.requireDonor, (ctx) => {
    const ids = parseList(ctx.body.ids).map(Number).filter(Boolean);
    if (ids.length) {
      db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(ctx.user.id, ...ids);
    } else db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(ctx.user.id);
    return { ok: true };
  });

  r.get('/api/donor/orphan-lookup/:no', auth.requireDonor, (ctx) => {
    const o = db.prepare(`SELECT orphan_no, name, monthly_amount, status FROM orphans WHERE orphan_no = ?`).get(ctx.params.no.trim());
    if (!o || o.status !== 'active') fail(404, 'Orphan number not found');
    return o;
  });

  r.get('/api/donor/payments', auth.requireDonor, (ctx) => {
    const rows = db.prepare('SELECT * FROM payments WHERE donor_id = ? ORDER BY payment_date DESC, id DESC').all(ctx.user.id);
    return { payments: rows.map((p) => {
      const d = decorate(db, p);
      // Donors see their own entry details but not internal review data.
      delete d.ocr_text; delete d.image_path; delete d.image_hash; delete d.reviewed_by;
      return d;
    }) };
  });

  r.post('/api/donor/payments', auth.requireDonor, (ctx) => {
    const p = createPayment(db, settings(), uploadsDir, {
      donorId: ctx.user.id, source: 'donor', fields: ctx.body, file: ctx.files.receipt, actorId: ctx.user.id,
    });
    return { payment: p };
  });

  r.get('/api/donor/export.csv', auth.requireDonor, (ctx) => {
    const rows = db.prepare(`SELECT p.*, u.name AS donor_name, u.phone AS donor_phone, u.email AS donor_email
      FROM payments p JOIN users u ON u.id = p.donor_id WHERE p.donor_id = ? ORDER BY p.payment_date`).all(ctx.user.id).map((p) => decorate(db, p));
    csv(ctx.res, 'my-donations.csv', PAYMENT_COLUMNS.filter((c) => !['flags', 'admin_note', 'source'].includes(c.label)), rows);
  });

  // ---- Management end ----------------------------------------------------
  const admin = auth.requireAdmin;

  r.get('/api/admin/dashboard', admin, (ctx) => {
    const s = settings();
    const month = monthParam(ctx.query);
    const { today } = clock(s);
    const from = `${month}-01`, to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    const byStatus = db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM payments WHERE payment_date BETWEEN ? AND ? GROUP BY status`).all(from, to);
    const stat = (st) => byStatus.find((x) => x.status === st) || { n: 0, total: 0 };
    const pendingAll = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'`).get().n;
    const flagged = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending' AND flags != '[]'`).get().n;
    const weekly = weeklyReport(db, s, month, ['verified', 'pending']);
    // "Paid" means verified; orphans covered only by entries still under review are counted separately.
    const coverage = coverageReport(db, month, ['verified']);
    const coverageWithPending = coverageReport(db, month, ['verified', 'pending']).summary;
    const recent = db.prepare(`SELECT p.*, u.name AS donor_name FROM payments p JOIN users u ON u.id = p.donor_id ORDER BY p.id DESC LIMIT 8`).all().map((p) => decorate(db, p));
    return {
      month, month_label: monthLabel(month), today,
      verified: stat('verified'), pending: stat('pending'), rejected: stat('rejected'),
      pending_all: pendingAll, flagged_pending: flagged,
      donors: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'donor' AND active = 1`).get().n,
      orphans: db.prepare(`SELECT COUNT(*) AS n FROM orphans WHERE status = 'active'`).get().n,
      weeks: weekly.weeks.map(({ entries, beneficiaries, ...w }) => w),
      totals: weekly.totals,
      coverage: { ...coverage.summary, awaiting_review: coverageWithPending.paid + coverageWithPending.partial - coverage.summary.paid - coverage.summary.partial },
      beneficiaries: weekly.beneficiaries.slice(0, 6),
      recent,
      pending_all_amount: db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE status = 'pending'`).get().t,
      orphans_total: db.prepare('SELECT COUNT(*) AS n FROM orphans').get().n,
      orphans_sponsored: db.prepare(`SELECT COUNT(*) AS n FROM orphans o WHERE o.status = 'active' AND EXISTS (SELECT 1 FROM donor_orphans d WHERE d.orphan_id = o.id)`).get().n,
      donors_with_login: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'donor' AND active = 1 AND password_hash IS NOT NULL`).get().n,
      batches: batchSummary(db, month),
      generated_at: new Date().toISOString(),
    };
  });

  r.get('/api/admin/payments', admin, (ctx) => {
    const q = ctx.query;
    const where = [], params = [];
    if (q.get('status')) { where.push('p.status = ?'); params.push(q.get('status')); }
    if (q.get('month')) { where.push('p.payment_date LIKE ?'); params.push(`${q.get('month')}-%`); }
    if (q.get('from')) { where.push('p.payment_date >= ?'); params.push(q.get('from')); }
    if (q.get('to')) { where.push('p.payment_date <= ?'); params.push(q.get('to')); }
    if (q.get('donor_id')) { where.push('p.donor_id = ?'); params.push(Number(q.get('donor_id'))); }
    if (q.get('flagged') === '1') where.push(`p.flags != '[]'`);
    if (q.get('covers_month')) { where.push('EXISTS (SELECT 1 FROM payment_months pm WHERE pm.payment_id = p.id AND pm.month = ?)'); params.push(q.get('covers_month')); }
    if (q.get('orphan_no')) {
      where.push('EXISTS (SELECT 1 FROM payment_months pm JOIN orphans o ON o.id = pm.orphan_id WHERE pm.payment_id = p.id AND o.orphan_no = ?)');
      params.push(q.get('orphan_no'));
    }
    if (q.get('q')) {
      const like = `%${q.get('q')}%`;
      where.push(`(u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR p.transaction_ref LIKE ? OR p.beneficiary_name LIKE ? OR p.beneficiary_account LIKE ? OR CAST(p.id AS TEXT) = ?)`);
      params.push(like, like, like, like, like, like, q.get('q'));
    }
    const sql = `FROM payments p JOIN users u ON u.id = p.donor_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const limit = Math.min(500, Number(q.get('limit')) || 100);
    const offset = Number(q.get('offset')) || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount),0) AS amount ${sql}`).get(...params);
    const rows = db.prepare(`SELECT p.*, u.name AS donor_name, u.phone AS donor_phone, u.email AS donor_email ${sql}
      ORDER BY p.payment_date DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { total: total.n, amount: total.amount, payments: rows.map((p) => decorate(db, p)) };
  });

  r.get('/api/admin/payments/:id', admin, (ctx) => {
    const p = getPayment(db, Number(ctx.params.id));
    if (!p) fail(404, 'Entry not found');
    return { payment: p };
  });

  r.post('/api/admin/payments', admin, (ctx) => {
    let donorId = Number(ctx.body.donor_id);
    if (!donorId) fail(400, 'Choose the donor');
    if (!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'donor'`).get(donorId)) fail(400, 'Donor not found');
    const p = createPayment(db, settings(), uploadsDir, {
      donorId, source: 'admin', fields: ctx.body, file: ctx.files.receipt, actorId: ctx.user.id,
    });
    return { payment: p };
  });

  r.put('/api/admin/payments/:id', admin, (ctx) => ({ payment: updatePayment(db, settings(), Number(ctx.params.id), ctx.body, ctx.user.id) }));
  r.post('/api/admin/payments/:id/verify', admin, (ctx) => ({ payment: setStatus(db, Number(ctx.params.id), 'verified', ctx.body.note, ctx.user.id) }));
  r.post('/api/admin/payments/:id/reject', admin, (ctx) => {
    if (!String(ctx.body.note || '').trim()) fail(400, 'Give a reason for rejecting (the donor will see it)');
    return { payment: setStatus(db, Number(ctx.params.id), 'rejected', ctx.body.note, ctx.user.id) };
  });
  r.post('/api/admin/payments/:id/reopen', admin, (ctx) => ({ payment: setStatus(db, Number(ctx.params.id), 'pending', ctx.body.note, ctx.user.id) }));
  r.post('/api/admin/payments/bulk-verify', admin, (ctx) => {
    const ids = parseList(ctx.body.ids).map(Number).filter(Boolean);
    tx(db, () => ids.forEach((id) => setStatus(db, id, 'verified', null, ctx.user.id)));
    return { count: ids.length };
  });
  r.delete('/api/admin/payments/:id', admin, (ctx) => { deletePayment(db, uploadsDir, Number(ctx.params.id), ctx.user.id); return { ok: true }; });

  // Orphans
  r.get('/api/admin/orphans', admin, () => ({
    orphans: db.prepare(`
      SELECT o.*, (SELECT GROUP_CONCAT(u.name, ', ') FROM donor_orphans d JOIN users u ON u.id = d.donor_id WHERE d.orphan_id = o.id) AS sponsors,
        (SELECT MAX(pm.month) FROM payment_months pm JOIN payments p ON p.id = pm.payment_id WHERE pm.orphan_id = o.id AND p.status != 'rejected') AS paid_until
      FROM orphans o ORDER BY o.orphan_no`).all(),
  }));

  // `cur` is the existing record: fields missing from `b` keep their current value (so a re-import
  // without a monthly_amount column doesn't wipe amounts set by hand).
  const orphanFields = (b, cur) => {
    const has = (k) => b[k] !== undefined || !cur;
    const txt = (k) => (has(k) ? String(b[k] ?? '').trim() || null : cur[k]);
    const o = {
      orphan_no: String(b.orphan_no ?? cur?.orphan_no ?? '').trim().toUpperCase(),
      name: tidyName(b.name ?? cur?.name ?? ''),
      name_ar: txt('name_ar'),
      child_phone: has('child_phone') ? cleanChildPhone(b.child_phone) : cur.child_phone,
      guardian_name: txt('guardian_name'),
      date_of_birth: txt('date_of_birth'),
      city: txt('city'),
      monthly_amount: has('monthly_amount') ? Number(String(b.monthly_amount || 0).replace(/,/g, '')) || 0 : cur.monthly_amount,
      status: has('status') ? (String(b.status).toLowerCase() === 'inactive' ? 'inactive' : 'active') : cur.status,
      notes: txt('notes'),
    };
    if (!o.orphan_no) fail(400, 'Orphan number is required');
    if (!o.name) fail(400, 'Orphan name is required');
    return o;
  };

  function upsertOrphan(b, actorId, id) {
    const byNo = db.prepare('SELECT * FROM orphans WHERE orphan_no = ?').get(String(b.orphan_no ?? '').trim().toUpperCase());
    const cur = id != null ? db.prepare('SELECT * FROM orphans WHERE id = ?').get(id) : byNo;
    const o = orphanFields(b, cur);
    const clash = db.prepare('SELECT id FROM orphans WHERE orphan_no = ?').get(o.orphan_no);
    if (id == null && clash) {
      id = clash.id;
    } else if (clash && clash.id !== id) {
      fail(409, `Orphan number ${o.orphan_no} already exists`);
    }
    if (id) {
      db.prepare(`UPDATE orphans SET orphan_no=?, name=?, name_ar=?, child_phone=?, guardian_name=?, date_of_birth=?, city=?, monthly_amount=?, status=?, notes=? WHERE id=?`)
        .run(o.orphan_no, o.name, o.name_ar, o.child_phone, o.guardian_name, o.date_of_birth, o.city, o.monthly_amount, o.status, o.notes, id);
      audit(db, actorId, 'orphan.update', 'orphan', id, o);
      return { id, created: false };
    }
    const res = db.prepare(`INSERT INTO orphans (orphan_no, name, name_ar, child_phone, guardian_name, date_of_birth, city, monthly_amount, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(o.orphan_no, o.name, o.name_ar, o.child_phone, o.guardian_name, o.date_of_birth, o.city, o.monthly_amount, o.status, o.notes);
    audit(db, actorId, 'orphan.create', 'orphan', Number(res.lastInsertRowid), o);
    return { id: Number(res.lastInsertRowid), created: true };
  }

  r.post('/api/admin/orphans', admin, (ctx) => {
    const o = orphanFields(ctx.body, null);
    if (db.prepare('SELECT 1 FROM orphans WHERE orphan_no = ?').get(o.orphan_no)) fail(409, `Orphan number ${o.orphan_no} already exists`);
    return upsertOrphan(ctx.body, ctx.user.id);
  });
  r.put('/api/admin/orphans/:id', admin, (ctx) => upsertOrphan(ctx.body, ctx.user.id, Number(ctx.params.id)));
  // Delete an orphan. Entries paid only for this orphan are deleted too when `with_entries=1`;
  // entries shared with other orphans must be edited first so their amounts stay correct.
  r.delete('/api/admin/orphans/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    const o = db.prepare('SELECT * FROM orphans WHERE id = ?').get(id);
    if (!o) fail(404, 'Orphan not found');
    const entries = db.prepare(`SELECT DISTINCT payment_id AS id FROM payment_months WHERE orphan_id = ?`).all(id).map((x) => x.id);
    const shared = entries.filter((pid) => db.prepare('SELECT 1 FROM payment_months WHERE payment_id = ? AND orphan_id != ?').get(pid, id));
    if (shared.length) {
      fail(409, `${o.orphan_no} is part of entries that also pay for other orphans (#${shared.join(', #')}). Edit those entries to remove ${o.orphan_no} first.`);
    }
    if (entries.length && ctx.query.get('with_entries') !== '1') {
      fail(409, `${o.orphan_no} has ${entries.length} donation entr${entries.length === 1 ? 'y' : 'ies'} (#${entries.join(', #')}). Confirm to delete them as well.`);
    }
    tx(db, () => {
      for (const pid of entries) deletePayment(db, uploadsDir, pid, ctx.user.id);
      db.prepare('DELETE FROM orphans WHERE id = ?').run(id);
      audit(db, ctx.user.id, 'orphan.delete', 'orphan', id, { orphan_no: o.orphan_no, name: o.name, entries_deleted: entries.length });
    });
    return { ok: true, entries_deleted: entries.length };
  });

  r.get('/api/admin/orphans/:id/ledger', admin, (ctx) => orphanLedger(db, Number(ctx.params.id)));
  r.get('/api/admin/orphans/:id/ledger.csv', admin, (ctx) => {
    const l = orphanLedger(db, Number(ctx.params.id));
    csv(ctx.res, `ledger-${l.orphan.orphan_no}.csv`, LEDGER_COLUMNS, l.rows);
  });

  // Donors
  r.get('/api/admin/donors', admin, () => ({
    donors: db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.city, u.sponsor_code, u.username, u.active, u.created_at, (u.password_hash IS NOT NULL) AS can_login,
        u.password_is_default, CASE WHEN u.password_is_default = 1 THEN u.default_password END AS issued_password,
        (SELECT GROUP_CONCAT(o.orphan_no, ';') FROM donor_orphans d JOIN orphans o ON o.id = d.orphan_id WHERE d.donor_id = u.id) AS orphan_nos,
        (SELECT COUNT(*) FROM payments p WHERE p.donor_id = u.id AND p.status != 'rejected') AS entries,
        (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.donor_id = u.id AND p.status = 'verified') AS verified_total,
        (SELECT MAX(payment_date) FROM payments p WHERE p.donor_id = u.id AND p.status != 'rejected') AS last_payment
      FROM users u WHERE u.role = 'donor' ORDER BY u.name`).all(),
  }));

  r.post('/api/admin/donors', admin, (ctx) => {
    const { password, ...rest } = ctx.body;
    if (password) validatePassword(password);
    const u = createDonor(rest, ctx.user.id);
    const missing = assignOrphans(u.id, ctx.body.orphan_nos);
    const login = issueLogin(db, u.id, { password: password || undefined });
    return { donor: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)), login, missing_orphans: missing };
  });

  r.put('/api/admin/donors/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'donor'`).get(id);
    if (!u) fail(404, 'Donor not found');
    const b = ctx.body;
    const email = b.email !== undefined ? cleanEmail(b.email) : u.email;
    const phone = b.phone !== undefined ? cleanPhone(b.phone) : u.phone;
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, id)) fail(409, 'Email already used by another account');
    if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(phone, id)) fail(409, 'Phone already used by another account');
    const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
    db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, city = ?, sponsor_code = ?, active = ?, session_version = session_version + ? WHERE id = ?')
      .run(String(b.name ?? u.name).trim() || u.name, email, phone, b.city !== undefined ? String(b.city).trim() || null : u.city,
        b.sponsor_code !== undefined ? cleanSponsorCode(b.sponsor_code) : u.sponsor_code, active, active ? 0 : 1, id);
    let missing = [];
    if (b.orphan_nos !== undefined) {
      db.prepare('DELETE FROM donor_orphans WHERE donor_id = ?').run(id);
      missing = assignOrphans(id, b.orphan_nos);
    }
    audit(db, ctx.user.id, 'donor.update', 'user', id, b);
    return { ok: true, missing_orphans: missing };
  });

  // Set or reset a donor's username and password. Blank fields follow the foundation's rules
  // (mobile number 03… or first name; password bua-<orphan code>).
  r.post('/api/admin/donors/:id/login', admin, (ctx) => {
    const id = Number(ctx.params.id);
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'donor'`).get(id);
    if (!u) fail(404, 'Donor not found');
    const username = String(ctx.body.username || '').trim();
    const password = String(ctx.body.password || '');
    if (username) {
      if (!validUsername(username)) fail(400, 'Username can use letters, numbers, dot, dash or underscore (3–40 characters)');
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(username, id)) fail(409, `Username ${username} is already taken`);
    }
    if (password) validatePassword(password);
    const login = issueLogin(db, id, { username: username || undefined, password: password || undefined });
    audit(db, ctx.user.id, 'donor.login_reset', 'user', id, { username: login.username });
    return { login };
  });
  // Kept for older screens: set just the password.
  r.post('/api/admin/donors/:id/password', admin, (ctx) => {
    validatePassword(ctx.body.password);
    const id = Number(ctx.params.id);
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'donor'`).get(id);
    if (!u) fail(404, 'Donor not found');
    const login = issueLogin(db, id, { username: u.username || undefined, password: ctx.body.password });
    audit(db, ctx.user.id, 'donor.password_reset', 'user', id, null);
    return { ok: true, login };
  });

  // Create logins for donors who don't have one (or reset everyone still on an issued password).
  r.post('/api/admin/donors/logins', admin, (ctx) => {
    const resetIssued = ctx.body.scope === 'reset_issued';
    const ids = db.prepare(`SELECT id FROM users WHERE role = 'donor' AND active = 1 AND (password_hash IS NULL ${resetIssued ? 'OR password_is_default = 1' : ''})`).all().map((x) => x.id);
    tx(db, () => ids.forEach((id) => issueLogin(db, id)));
    audit(db, ctx.user.id, 'donor.logins_issued', null, null, { count: ids.length, scope: resetIssued ? 'reset_issued' : 'missing' });
    return { count: ids.length };
  });

  r.get('/api/admin/export/logins.csv', admin, (ctx) => {
    const rows = db.prepare(`
      SELECT u.name, u.sponsor_code, u.phone, u.username, u.default_password AS password,
        (SELECT GROUP_CONCAT(o.orphan_no, ';') FROM donor_orphans d JOIN orphans o ON o.id = d.orphan_id WHERE d.donor_id = u.id) AS orphan_nos
      FROM users u WHERE u.role = 'donor' AND u.active = 1 AND u.password_is_default = 1 ORDER BY u.name`).all()
      .map((x) => ({ ...x, mobile: localPkMobile(x.phone) || x.phone }));
    csv(ctx.res, 'donor-logins.csv', ['name', 'sponsor_code', 'mobile', 'username', 'password', 'orphan_nos'].map((k) => ({ key: k, label: k })), rows);
  });

  // Delete a donor. Their donation entries (and receipt images) go too when `with_entries=1`.
  r.delete('/api/admin/donors/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'donor'`).get(id);
    if (!u) fail(404, 'Donor not found');
    const entries = db.prepare('SELECT id FROM payments WHERE donor_id = ?').all(id).map((x) => x.id);
    if (entries.length && ctx.query.get('with_entries') !== '1') {
      fail(409, `${u.name} has ${entries.length} donation entr${entries.length === 1 ? 'y' : 'ies'}. Confirm to delete them as well.`);
    }
    tx(db, () => {
      for (const pid of entries) deletePayment(db, uploadsDir, pid, ctx.user.id);
      db.prepare('DELETE FROM donor_orphans WHERE donor_id = ?').run(id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
      db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      audit(db, ctx.user.id, 'donor.delete', 'user', id, { name: u.name, phone: u.phone, entries_deleted: entries.length });
    });
    return { ok: true, entries_deleted: entries.length };
  });

  r.get('/api/admin/donors/:id/ledger', admin, (ctx) => donorLedger(db, Number(ctx.params.id)));
  r.get('/api/admin/donors/:id/ledger.csv', admin, (ctx) => {
    const l = donorLedger(db, Number(ctx.params.id));
    csv(ctx.res, `ledger-${l.donor.name.replace(/[^A-Za-z0-9]+/g, '-')}.csv`, LEDGER_COLUMNS, l.rows);
  });

  registerBatchRoutes({ r, db, admin, csv, today: () => clock(settings()).today });

  // Management users
  r.get('/api/admin/admins', admin, () => ({
    admins: db.prepare(`SELECT id, name, email, phone, active, created_at FROM users WHERE role = 'admin' ORDER BY id`).all(),
  }));
  r.post('/api/admin/admins', admin, (ctx) => {
    const b = ctx.body;
    const email = cleanEmail(b.email);
    if (!String(b.name || '').trim() || !email) fail(400, 'Name and email are required');
    validatePassword(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Email already registered');
    const res = db.prepare(`INSERT INTO users (role, name, email, password_hash) VALUES ('admin', ?, ?, ?)`).run(String(b.name).trim(), email, hashPassword(b.password));
    audit(db, ctx.user.id, 'admin.create', 'user', Number(res.lastInsertRowid), { email });
    return { id: Number(res.lastInsertRowid) };
  });
  r.put('/api/admin/admins/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    if (id === ctx.user.id && ctx.body.active === false) fail(400, 'You cannot deactivate your own account');
    db.prepare(`UPDATE users SET active = ?, session_version = session_version + 1 WHERE id = ? AND role = 'admin'`).run(ctx.body.active ? 1 : 0, id);
    audit(db, ctx.user.id, 'admin.update', 'user', id, ctx.body);
    return { ok: true };
  });

  // Settings
  r.get('/api/admin/settings', admin, () => ({ settings: settings() }));
  r.put('/api/admin/settings', admin, (ctx) => {
    const b = ctx.body, patch = {};
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      if (b[k] === undefined) continue;
      if (typeof def === 'number') {
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < 0) fail(400, `${k} must be a positive number`);
        patch[k] = n;
      } else if (typeof def === 'boolean') patch[k] = !!b[k];
      else if (Array.isArray(def)) {
        if (!Array.isArray(b[k])) fail(400, `${k} must be a list`);
        patch[k] = b[k].map((a) => ({
          title: String(a.title || '').trim(), bank: String(a.bank || '').trim(), account: normalizeAccount(a.account),
        })).filter((a) => a.account);
      } else patch[k] = String(b[k]).trim();
    }
    if (patch.timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: patch.timezone }); } catch { fail(400, 'Unknown time zone'); }
    }
    audit(db, ctx.user.id, 'settings.update', 'settings', null, patch);
    return { settings: saveSettings(db, patch) };
  });

  // Reports
  r.get('/api/admin/reports/weekly', admin, (ctx) => weeklyReport(db, settings(), monthParam(ctx.query), statusesParam(ctx.query)));
  r.get('/api/admin/reports/weekly.csv', admin, (ctx) => {
    const rep = weeklyReport(db, settings(), monthParam(ctx.query), statusesParam(ctx.query));
    const rows = rep.weeks.flatMap((w) => w.entries.map((p) => ({ ...p, week: `Week ${w.week} (${w.from} to ${w.to})` })));
    csv(ctx.res, `weekly-report-${rep.month}.csv`, [{ key: 'week', label: 'week' }, ...PAYMENT_COLUMNS], rows);
  });
  r.get('/api/admin/reports/coverage', admin, (ctx) => coverageReport(db, monthParam(ctx.query), statusesParam(ctx.query)));
  r.get('/api/admin/reports/coverage.csv', admin, (ctx) => {
    const rep = coverageReport(db, monthParam(ctx.query), statusesParam(ctx.query));
    csv(ctx.res, `orphan-coverage-${rep.month}.csv`, [
      { key: 'orphan_no', label: 'orphan_no' }, { key: 'orphan_name', label: 'orphan_name' }, { key: 'guardian_name', label: 'guardian_name' },
      { key: 'monthly_amount', label: 'monthly_amount' }, { key: 'paid', label: 'paid' }, { key: 'state', label: 'state' },
      { label: 'paid_in_advance', value: (x) => (x.paid_in_advance ? 'yes' : '') },
      { label: 'sponsors', value: (x) => x.sponsors.map((s) => `${s.name}${s.phone ? ` (${s.phone})` : ''}`).join('; ') },
      { label: 'entry_ids', value: (x) => x.payments.map((p) => p.id).join(';') },
    ], rep.rows);
  });
  const rangeParams = (q) => {
    const { month } = clock(settings());
    const from = q.get('from') || `${month}-01`;
    const to = q.get('to') || `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) fail(400, 'from/to must be YYYY-MM-DD');
    return { from, to };
  };
  r.get('/api/admin/reports/beneficiaries', admin, (ctx) => {
    const { from, to } = rangeParams(ctx.query);
    return beneficiaryReport(db, settings(), from, to, statusesParam(ctx.query));
  });
  r.get('/api/admin/reports/beneficiaries.csv', admin, (ctx) => {
    const { from, to } = rangeParams(ctx.query);
    const rep = beneficiaryReport(db, settings(), from, to, statusesParam(ctx.query));
    csv(ctx.res, `beneficiaries-${from}-to-${to}.csv`, [
      { key: 'beneficiary_name', label: 'beneficiary_name' }, { key: 'beneficiary_account', label: 'beneficiary_account' },
      { key: 'beneficiary_bank', label: 'beneficiary_bank' }, { label: 'official_account', value: (g) => (g.official ? 'yes' : 'NO') },
      { key: 'count', label: 'payments' }, { key: 'total', label: 'total' }, { key: 'first_date', label: 'first_date' },
      { key: 'last_date', label: 'last_date' }, { label: 'entry_ids', value: (g) => g.payment_ids.join(';') },
    ], rep.groups);
  });

  // Export
  r.get('/api/admin/export/payments.csv', admin, (ctx) => {
    const q = ctx.query;
    const from = q.get('from') || '0000-01-01', to = q.get('to') || '9999-12-31';
    const statuses = q.get('status') ? q.get('status').split(',') : ['pending', 'verified', 'rejected'];
    csv(ctx.res, `donation-entries-${clock(settings()).today}.csv`, PAYMENT_COLUMNS, paymentsInRange(db, from, to, statuses));
  });
  r.get('/api/admin/export/months.csv', admin, (ctx) => {
    const rows = db.prepare(`
      SELECT pm.month, o.orphan_no, o.name AS orphan_name, pm.amount, p.id AS entry_id, p.payment_date, p.status,
        u.name AS donor_name, u.phone AS donor_phone, p.transaction_ref, p.beneficiary_account
      FROM payment_months pm JOIN payments p ON p.id = pm.payment_id JOIN orphans o ON o.id = pm.orphan_id JOIN users u ON u.id = p.donor_id
      ORDER BY pm.month, o.orphan_no`).all();
    const cols = Object.keys(rows[0] || { month: 1, orphan_no: 1, orphan_name: 1, amount: 1, entry_id: 1, payment_date: 1, status: 1, donor_name: 1, donor_phone: 1, transaction_ref: 1, beneficiary_account: 1 })
      .map((k) => ({ key: k, label: k }));
    csv(ctx.res, `month-allocations-${clock(settings()).today}.csv`, cols, rows);
  });
  r.get('/api/admin/export/orphans.csv', admin, (ctx) => {
    csv(ctx.res, 'orphans.csv', ORPHAN_COLUMNS, db.prepare('SELECT * FROM orphans ORDER BY orphan_no').all());
  });
  r.get('/api/admin/export/donors.csv', admin, (ctx) => {
    const rows = db.prepare(`SELECT u.name, u.phone, u.email, u.city, u.sponsor_code,
      (SELECT GROUP_CONCAT(o.orphan_no, ';') FROM donor_orphans d JOIN orphans o ON o.id = d.orphan_id WHERE d.donor_id = u.id) AS orphan_nos
      FROM users u WHERE role = 'donor' ORDER BY name`).all();
    csv(ctx.res, 'donors.csv', TEMPLATES.donors.columns.filter((c) => c.key !== 'password'), rows);
  });
  r.get('/api/admin/import/template/:kind', admin, (ctx) => {
    const kind = ctx.params.kind.replace(/\.csv$/, '');
    const t = TEMPLATES[kind];
    if (!t) fail(404, 'Unknown template');
    csv(ctx.res, `${kind}-template.csv`, t.columns, t.sample);
  });

  // Import (CSV or Excel .xlsx). dry_run=1 validates everything and rolls back.
  r.post('/api/admin/import/:kind', admin, (ctx) => {
    const kind = ctx.params.kind;
    if (!['orphans', 'donors', 'payments'].includes(kind)) fail(404, 'Unknown import type');
    const file = ctx.files.file;
    let rows;
    if (file && isXlsx(file.data)) rows = parseXlsx(file.data);
    else {
      const text = file ? file.data.toString('utf8') : ctx.body.csv;
      if (!text) fail(400, 'Choose a CSV or Excel file to import');
      rows = parseCsv(text);
    }
    rows = rows.map((row) => applyAliases(kind, row));
    if (!rows.length) fail(400, 'The file has no data rows');
    if (rows.length > 5000) fail(400, 'Import at most 5000 rows at a time');
    const dryRun = ['1', 'true', true].includes(ctx.body.dry_run);
    const s = settings();
    const result = {
      kind, dry_run: dryRun, total: rows.length, created: 0, updated: 0, skipped: 0, errors: [], skipped_rows: [],
      donors_created: 0, sponsors_linked: 0, no_sponsor: 0, logins_created: 0,
    };
    const newDonors = new Set();

    // Orphan sheets may carry the sponsor on each row: create/find that donor and link them.
    function linkSponsor(orphanId, row) {
      if (!['sponsor_name', 'sponsor_phone', 'sponsor_code'].some((k) => k in row)) return;
      const code = cleanSponsorCode(row.sponsor_code);
      const name = String(row.sponsor_name || '').trim().replace(/\s+/g, ' ');
      const namedSponsor = name && !NO_SPONSOR.test(name);
      const phone = cleanPhone(row.sponsor_phone);
      if (!phone && !namedSponsor) { result.no_sponsor++; return; }
      let donor = phone ? db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) : null;
      if (donor && donor.role !== 'donor') fail(400, `Sponsor phone ${phone} belongs to a management account`);
      if (!donor && !phone) {
        donor = db.prepare(`SELECT * FROM users WHERE role = 'donor' AND phone IS NULL AND email IS NULL
          AND lower(name) = lower(?) AND COALESCE(sponsor_code, '') = ?`).get(name, code || '');
      }
      if (!donor) {
        donor = createDonor({ name: namedSponsor ? tidyName(name) : `Sponsor ${code || phone}`, phone, city: row.sponsor_area, sponsor_code: code }, ctx.user.id, { allowNoLogin: true });
        newDonors.add(donor.id);
        result.donors_created++;
      } else if (code && !String(donor.sponsor_code || '').split(';').includes(code)) {
        db.prepare('UPDATE users SET sponsor_code = ? WHERE id = ?').run(donor.sponsor_code ? `${donor.sponsor_code};${code}` : code, donor.id);
      }
      db.prepare('INSERT OR IGNORE INTO donor_orphans (donor_id, orphan_id) VALUES (?, ?)').run(donor.id, orphanId);
      result.sponsors_linked++;
    }

    const handlers = {
      orphans: (row) => {
        if (!row.orphan_no && !row.name) {
          result.skipped++;
          result.skipped_rows.push({ row: row._row, reason: `No orphan code or name${row.child_phone ? ` (only a phone number: ${row.child_phone})` : ''}` });
          return;
        }
        const x = upsertOrphan(row, ctx.user.id);
        result[x.created ? 'created' : 'updated']++;
        linkSponsor(x.id, row);
      },
      donors: (row) => {
        const existing = findUserByLogin(row.email) || findUserByLogin(row.phone);
        if (existing) {
          if (existing.role !== 'donor') fail(400, 'Login belongs to a management account');
          assignOrphans(existing.id, row.orphan_nos);
          result.updated++;
          return;
        }
        const { password, ...rest } = row;
        const u = createDonor(rest, ctx.user.id);
        const missing = assignOrphans(u.id, row.orphan_nos);
        if (missing.length) fail(400, `Unknown orphan numbers: ${missing.join(', ')}`);
        issueLogin(db, u.id, { password: password || undefined });
        result.logins_created++;
        result.created++;
      },
      payments: (row) => {
        const ref = String(row.transaction_ref || '').toUpperCase().replace(/\s/g, '');
        if (ref && db.prepare(`SELECT 1 FROM payments WHERE UPPER(REPLACE(transaction_ref,' ','')) = ?`).get(ref)) {
          result.skipped++;
          result.skipped_rows.push({ row: row._row, reason: `Transaction ID ${row.transaction_ref} is already in the system` });
          return;
        }
        let donor = findUserByLogin(row.donor_email) || findUserByLogin(row.donor_phone);
        if (donor && donor.role !== 'donor') fail(400, 'Donor login belongs to a management account');
        if (!donor) {
          if (!row.donor_name) fail(400, 'donor_name is required for new donors');
          donor = createDonor({ name: row.donor_name, email: row.donor_email, phone: row.donor_phone }, ctx.user.id);
        }
        const months = parseList(row.months).map(normalizeMonth);
        createPayment(db, s, uploadsDir, {
          donorId: donor.id, source: 'import', actorId: ctx.user.id,
          fields: { ...row, months, status: String(row.status || 'pending').toLowerCase(), submitted_on: row.payment_date, submitted_at: row.submitted_at || null },
        });
        result.created++;
      },
    };
    const handler = handlers[kind];
    if (!handler) fail(404, 'Unknown import type');

    const run = () => {
      rows.forEach((row, i) => {
        try { tx(db, () => handler(row)); } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          result.errors.push({ row: row._row ?? i + 2, message: e.message });
        }
      });
      // New sponsors get their login once all their orphans are linked (password uses their orphan code).
      for (const id of newDonors) {
        if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) { issueLogin(db, id); result.logins_created++; }
      }
    };
    if (dryRun) {
      db.exec('BEGIN');
      try { run(); } finally { db.exec('ROLLBACK'); }
    } else {
      run();
      audit(db, ctx.user.id, `import.${kind}`, null, null, {
        created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length,
        donors_created: result.donors_created, sponsors_linked: result.sponsors_linked,
      });
    }
    return result;
  });

  r.get('/api/admin/audit', admin, () => ({
    entries: db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`).all(),
  }));

  // ---- Request pipeline --------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!url.pathname.startsWith('/api/')) {
      if (['GET', 'HEAD'].includes(req.method) && serveStatic(PUBLIC, req, res, url.pathname)) return;
      return sendJson(res, 404, { error: 'Not found' });
    }
    try {
      const match = r.match(req.method, url.pathname);
      if (!match) fail(404, 'Not found');
      const ctx = {
        req, res, params: match.params, query: url.searchParams, body: {}, files: {},
        user: auth.currentUser(req), ip: clientIp(req),
      };
      if (!['GET', 'HEAD'].includes(req.method)) {
        // CSRF: session cookie is SameSite=Strict; additionally require a same-origin request.
        const origin = req.headers.origin;
        let originHost = null;
        try { originHost = origin ? new URL(origin).host : null; } catch { /* opaque origin */ }
        if (origin && originHost !== req.headers.host) fail(403, 'Cross-site request blocked');
        const type = req.headers['content-type'] || '';
        const limit = (settings().maxUploadMb + 2) * 1024 * 1024;
        const raw = await readBody(req, limit);
        if (type.startsWith('multipart/form-data')) {
          const mp = parseMultipart(raw, type);
          ctx.body = mp.fields;
          ctx.files = mp.files;
        } else if (raw.length) {
          if (!type.includes('application/json')) fail(415, 'Send JSON or multipart form data');
          try { ctx.body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
        }
      }
      let out;
      for (const h of match.handlers) out = await h(ctx);
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, details: e.details });
      if (/UNIQUE constraint/.test(e.message)) return sendJson(res, 409, { error: 'A record with these details already exists' });
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, db, bootstrap };
}
