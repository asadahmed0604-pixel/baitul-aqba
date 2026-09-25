import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { todayIn, addMonths } from '../public/shared/receipt-parser.js';

const today = todayIn('Asia/Karachi');
const month = today.slice(0, 7);
const lastMonth = addMonths(month, -1);
const nextMonth = addMonths(month, 1);

let app, base, dir;

function png(width, height, salt = '') {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return Buffer.concat([b, Buffer.from(salt)]);
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { form } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
}

function receiptForm(fields, image) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  if (image) fd.append('receipt', new Blob([image], { type: 'image/png' }), 'receipt.png');
  return fd;
}

const ocr = (date, amount = '5,000', ref = 'TX1001') => `Meezan Bank
Funds Transfer
Transaction Date: ${date}
Amount: Rs. ${amount}
Beneficiary Name: BAIT UL AQBA FOUNDATION
Beneficiary Account: PK36MEZN0001230104567890
Transaction ID: ${ref}`;

const adminC = new Client();
const donor = new Client();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bua-'));
  process.env.ADMIN_EMAIL = 'boss@example.org';
  process.env.ADMIN_PASSWORD = 'secret123';
  app = createApp({ dataDir: dir, uploadsDir: path.join(dir, 'uploads') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('management login, orphans and settings', async () => {
  const bad = await adminC.post('/api/auth/login', { login: 'boss@example.org', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await adminC.post('/api/auth/login', { login: 'boss@example.org', password: 'secret123', role: 'admin' });
  assert.equal(ok.status, 200);
  for (const [no, name] of [['BUA-001', 'Ali'], ['BUA-002', 'Sana'], ['BUA-003', 'Omar']]) {
    const r = await adminC.post('/api/admin/orphans', { orphan_no: no, name, monthly_amount: 5000 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const dup = await adminC.post('/api/admin/orphans', { orphan_no: 'bua-001', name: 'X' });
  assert.equal(dup.status, 409);
  const s = await adminC.put('/api/admin/settings', {
    officialAccounts: [{ title: 'Bait ul Aqba Foundation', bank: 'Meezan Bank', account: 'PK36 MEZN 0001 2301 0456 7890' }],
  });
  assert.equal(s.data.settings.officialAccounts[0].account, 'PK36MEZN0001230104567890');
});

test('donor registration and access control', async () => {
  const r = await donor.post('/api/auth/register', { name: 'Ahmed Khan', phone: '0300-1234567', password: 'pass1234' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.phone, '+923001234567'); // stored in one canonical form
  const blocked = await donor.get('/api/admin/payments');
  assert.equal(blocked.status, 403);
  const anon = await new Client().get('/api/donor/payments');
  assert.equal(anon.status, 401);
  const relog = await new Client().post('/api/auth/login', { login: '03001234567', password: 'pass1234', role: 'donor' });
  assert.equal(relog.status, 200);
});

test('donor submits current-month receipt with advance months', async () => {
  const fields = {
    orphan_nos: ['BUA-001'], months: [month, nextMonth], amount: '10000', payment_date: today,
    ocr_text: ocr(today, '10,000', 'TX-ADV-1'), ocr_confidence: 88, sharpness: 150,
  };
  const r = await donor.req('POST', '/api/donor/payments', undefined, { form: receiptForm(fields, png(1080, 1920, 'a')) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data.payment;
  assert.equal(p.status, 'pending');
  assert.deepEqual(p.months, [month, nextMonth]);
  assert.deepEqual(p.allocations.map((a) => a.amount), [5000, 5000]);
  assert.equal(p.beneficiary_account, 'PK36MEZN0001230104567890');
  assert.equal(p.beneficiary_name, 'BAIT UL AQBA FOUNDATION');
  assert.equal(p.transaction_ref, 'TX-ADV-1');
  assert.deepEqual(p.flags, []);
  assert.ok(!p.flags.some((f) => f.code === 'unknown_beneficiary_account'));

  const img = await donor.get(`/api/payments/${p.id}/image`);
  assert.equal(img.status, 200);
  const other = new Client();
  await other.post('/api/auth/register', { name: 'Other', email: 'other@example.com', password: 'pass1234' });
  assert.equal((await other.get(`/api/payments/${p.id}/image`)).status, 403);
});

test('receipts outside the current month are rejected', async () => {
  const oldDate = `${lastMonth}-15`;
  const base = { orphan_nos: 'BUA-002', months: month, amount: '5000', ocr_confidence: 90, sharpness: 150 };
  let r = await donor.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ ...base, payment_date: oldDate, ocr_text: ocr(oldDate) }, png(1000, 1000, 'b')),
  });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /current month/);

  // Donor types today's date but the receipt image shows last month.
  r = await donor.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ ...base, payment_date: today, ocr_text: ocr(oldDate) }, png(1000, 1000, 'c')),
  });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /not in the current month/);
});

test('unclear receipts are rejected', async () => {
  const base = { orphan_nos: 'BUA-002', months: month, amount: '5000', payment_date: today, ocr_text: ocr(today, '5,000', 'TX-UNCLEAR') };
  let r = await donor.req('POST', '/api/donor/payments', undefined, { form: receiptForm({ ...base, ocr_confidence: 30, sharpness: 150 }, png(1000, 1000, 'd')) });
  assert.equal(r.status, 422);
  r = await donor.req('POST', '/api/donor/payments', undefined, { form: receiptForm({ ...base, ocr_confidence: 90, sharpness: 5 }, png(1000, 1000, 'e')) });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /blurry/);
  r = await donor.req('POST', '/api/donor/payments', undefined, { form: receiptForm({ ...base, ocr_confidence: 90, sharpness: 150 }, png(200, 150, 'f')) });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /too small/);
  r = await donor.req('POST', '/api/donor/payments', undefined, { form: receiptForm({ ...base, ocr_confidence: 90, sharpness: 150 }) });
  assert.equal(r.status, 400);
});

test('duplicates are blocked and unknown beneficiaries flagged', async () => {
  const dupImg = png(1080, 1920, 'a');
  let r = await donor.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ orphan_nos: 'BUA-002', months: month, amount: 5000, payment_date: today, ocr_text: ocr(today, '5,000', 'NEW1'), ocr_confidence: 90, sharpness: 150 }, dupImg),
  });
  assert.equal(r.status, 409);
  r = await donor.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ orphan_nos: 'BUA-002', months: month, amount: 5000, payment_date: today, ocr_text: ocr(today, '5,000', 'TX-ADV-1'), ocr_confidence: 90, sharpness: 150 }, png(900, 900, 'g')),
  });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /transaction ID/);

  const text = `HBL\nDate: ${today}\nAmount: Rs 3,000\nTo: Zainab Bibi\nAccount Number: 1234 5678 9012 34\nTID: 99887766`;
  r = await donor.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ orphan_nos: 'BUA-002', months: month, amount: 3000, payment_date: today, ocr_text: text, ocr_confidence: 80, sharpness: 150 }, png(900, 900, 'h')),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.payment.beneficiary_account, '12345678901234');
  assert.ok(r.data.payment.flags.some((f) => f.code === 'unknown_beneficiary_account'));
});

test('management review, weekly report, coverage and beneficiaries', async () => {
  const list = await adminC.get('/api/admin/payments?status=pending');
  assert.equal(list.data.total, 2);
  const [unknown, adv] = list.data.payments;
  assert.equal((await adminC.post(`/api/admin/payments/${adv.id}/verify`, {})).data.payment.status, 'verified');
  assert.equal((await adminC.post(`/api/admin/payments/${unknown.id}/reject`, {})).status, 400);
  assert.equal((await adminC.post(`/api/admin/payments/${unknown.id}/reject`, { note: 'Paid to wrong account' })).data.payment.status, 'rejected');

  const weekly = await adminC.get(`/api/admin/reports/weekly?month=${month}`);
  assert.equal(weekly.status, 200);
  assert.equal(weekly.data.totals.total, 10000);
  assert.equal(weekly.data.totals.current_total, 5000);
  assert.equal(weekly.data.totals.advance_total, 5000);
  const wk = Math.min(5, Math.ceil(Number(today.slice(8)) / 7));
  assert.equal(weekly.data.weeks[wk - 1].count, 1);
  assert.equal(weekly.data.beneficiaries[0].official, true);

  const cov = await adminC.get(`/api/admin/reports/coverage?month=${nextMonth}`);
  const row = cov.data.rows.find((x) => x.orphan_no === 'BUA-001');
  assert.equal(row.state, 'paid');
  assert.equal(row.paid_in_advance, true);
  assert.equal(cov.data.summary.unpaid, 2);

  const ben = await adminC.get(`/api/admin/reports/beneficiaries?from=${month}-01&to=${month}-31&status=verified,pending,rejected`);
  assert.equal(ben.data.groups.length, 2);

  const csv = await adminC.get(`/api/admin/reports/weekly.csv?month=${month}`);
  assert.match(csv.data, /week,entry_id,donor_name/);

  const mine = await donor.get('/api/donor/payments');
  assert.equal(mine.data.payments.find((p) => p.id === unknown.id).admin_note, 'Paid to wrong account');
  const orphans = await donor.get('/api/donor/orphans');
  assert.equal(orphans.data.orphans.find((o) => o.orphan_no === 'BUA-001').paid_through, nextMonth);
});

test('admin edit re-allocates months', async () => {
  const list = await adminC.get('/api/admin/payments?status=verified');
  const id = list.data.payments[0].id;
  const r = await adminC.put(`/api/admin/payments/${id}`, { orphan_nos: ['BUA-001', 'BUA-003'], months: [month] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.payment.allocations.map((a) => [a.orphan_no, a.amount]), [['BUA-001', 5000], ['BUA-003', 5000]]);
});

test('export and import round trip', async () => {
  const exp = await adminC.get('/api/admin/export/payments.csv');
  assert.equal(exp.status, 200);
  assert.match(exp.data, /entry_id,donor_name/);

  const csv = [
    'donor_name,donor_phone,donor_email,orphan_nos,months,amount,payment_date,bank_name,transaction_ref,beneficiary_name,beneficiary_account,status',
    `Bilal,03111111111,,BUA-003,"${lastMonth};${month}",8000,${lastMonth}-10,UBL,IMP-1,Bait ul Aqba,PK36MEZN0001230104567890,verified`,
    `Bilal,03111111111,,BUA-999,${month},100,${month}-01,UBL,IMP-2,,,pending`,
    `Ahmed Khan,03001234567,,BUA-002,${month},5000,${month}-02,Meezan,TX-ADV-1,,,pending`,
  ].join('\n');
  const dry = await adminC.post('/api/admin/import/payments', { csv, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.created, 1);
  assert.equal(dry.data.skipped, 1);
  assert.equal(dry.data.errors.length, 1);
  assert.equal(dry.data.errors[0].row, 3);
  assert.equal((await adminC.get('/api/admin/payments?q=IMP-1')).data.total, 0, 'dry run must not write');

  const real = await adminC.post('/api/admin/import/payments', { csv });
  assert.equal(real.data.created, 1);
  const imported = (await adminC.get('/api/admin/payments?q=IMP-1')).data.payments[0];
  assert.equal(imported.status, 'verified');
  assert.equal(imported.source, 'import');
  assert.deepEqual(imported.months, [lastMonth, month]);

  const orphanCsv = 'orphan_no,name,monthly_amount\nBUA-010,Hira,4000\nBUA-001,Ali Updated,5000\n';
  const o = await adminC.post('/api/admin/import/orphans', { csv: orphanCsv });
  assert.deepEqual([o.data.created, o.data.updated], [1, 1]);

  const tpl = await adminC.get('/api/admin/import/template/payments.csv');
  assert.match(tpl.data, /BUA-001/);
});

// Build a minimal .xlsx (stored, uncompressed zip) with inline strings.
function xlsx(rows) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`).join('')
  }</sheetData></worksheet>`;
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('imports the foundation orphan sheet (.xlsx) with sponsors', async () => {
  const sheet = xlsx([
    ['Code', "Orphan's Name", 'Name', 'Child Phone', 'SP Code', 'Sponsor Name', 'Sponsor Phone', 'Sponsor Area'],
    ['OR001', 'Maram Tariq', 'مرام طارق', '972592515321', 'SP11', 'Shafqat Ara', '+92 311 5959391', 'Gilgit'],
    ['OR002 ', 'Anas Khalid', 'أنس خالد', '972 59-259-9069', 'SP11', 'Shafqat Ara', '+92 311 5959391', 'Gilgit'],
    ['OR003', 'Obaida Raif', 'عبيدة رائف', '00972567616268', 'N/A', 'No Sponsor', '', ''],
    ['OR004', 'Emad Mohammed', 'عماد محمد', '+970592407547', 'SP379', 'Al-Ghurba', '', ''],
    ['OR005', 'Amira Mahmood', 'أميرة محمود', '972597402516', '', 'Imran Hamza', '+923204000455', ''],
    ['', '', '', '+972597789104', '', '', '', ''],
  ]);
  const send = (dry) => {
    const fd = new FormData();
    fd.append('file', new Blob([sheet]), 'Printable.xlsx');
    fd.append('dry_run', dry ? '1' : '0');
    return adminC.req('POST', '/api/admin/import/orphans', undefined, { form: fd });
  };
  const dry = await send(true);
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.deepEqual([dry.data.created, dry.data.errors.length, dry.data.skipped], [5, 0, 1]);
  assert.equal(dry.data.skipped_rows[0].row, 7);
  const real = await send(false);
  assert.deepEqual([real.data.created, real.data.donors_created, real.data.sponsors_linked, real.data.no_sponsor], [5, 3, 4, 1]);

  const { orphans } = (await adminC.get('/api/admin/orphans')).data;
  const or2 = orphans.find((o) => o.orphan_no === 'OR002');
  assert.equal(or2.name, 'Anas Khalid');
  assert.equal(or2.name_ar, 'أنس خالد');
  assert.equal(or2.child_phone, '+972592599069');
  assert.equal(orphans.find((o) => o.orphan_no === 'OR003').child_phone, '+972567616268');
  const { donors } = (await adminC.get('/api/admin/donors')).data;
  const shafqat = donors.find((d) => d.name === 'Shafqat Ara');
  assert.equal(shafqat.phone, '+923115959391');
  assert.equal(shafqat.sponsor_code, 'SP11');
  assert.equal(shafqat.orphan_nos, 'OR001;OR002');

  // Imported sponsors get a login straight away: mobile number 03… and password bua-<orphan code>.
  assert.equal(real.data.logins_created, 3);
  const imran = new Client();
  const li = await imran.post('/api/auth/login', { login: '03204000455', password: 'bua-or005', role: 'donor' });
  assert.equal(li.status, 200, JSON.stringify(li.data));
  assert.equal(li.data.user.username, '03204000455');
  assert.equal(li.data.user.must_change_password, true);
  assert.deepEqual((await imran.get('/api/donor/orphans')).data.orphans.map((o) => o.orphan_no), ['OR005']);
  // Registering again with that number explains how to sign in instead.
  const again409 = await new Client().post('/api/auth/register', { name: 'X', phone: '0320-4000455', password: 'another1' });
  assert.equal(again409.status, 409);
  assert.match(again409.data.error, /bua-/);
  // Changing the password clears the "issued password" state.
  assert.equal((await imran.post('/api/auth/password', { current: 'bua-or005', next: 'mine-now' })).status, 200);
  assert.equal((await imran.get('/api/auth/me')).data.user.must_change_password, false);

  // The sponsor can later sign in with the local number format once a password is set.
  await adminC.post(`/api/admin/donors/${shafqat.id}/password`, { password: 'sponsor1' });
  assert.equal((await new Client().post('/api/auth/login', { login: '0311-5959391', password: 'sponsor1' })).status, 200);

  // Re-importing is safe: nothing duplicated, amounts set by hand are kept.
  await adminC.put(`/api/admin/orphans/${or2.id}`, { ...or2, monthly_amount: 6000 });
  const again = await send(false);
  assert.deepEqual([again.data.created, again.data.updated, again.data.donors_created], [0, 5, 0]);
  assert.equal((await adminC.get('/api/admin/orphans')).data.orphans.find((o) => o.orphan_no === 'OR002').monthly_amount, 6000);
});

test('login rules: mobile number or first name, bua-<orphan code>, reset by management', async () => {
  // Donors outside Pakistan get their first name as username.
  const r = await adminC.post('/api/admin/donors', { name: 'Dr Rizwana Khan', phone: '+1 504 919 3426', orphan_nos: 'OR003' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.login, { username: 'rizwana', password: 'bua-or003' });
  const r2 = await adminC.post('/api/admin/donors', { name: 'Rizwana Bibi', phone: '+44 7700 900123', orphan_nos: 'OR004' });
  assert.equal(r2.data.login.username, 'rizwana2');
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { login: 'Rizwana', password: 'bua-or003' })).status, 200);

  // Management resets the username and password.
  const id = r.data.donor.id;
  const reset = await adminC.post(`/api/admin/donors/${id}/login`, { username: 'rizwana.k', password: 'fresh-pass' });
  assert.deepEqual(reset.data.login, { username: 'rizwana.k', password: 'fresh-pass' });
  assert.equal((await c.get('/api/auth/me')).data.user, null, 'old session ends after a reset');
  assert.equal((await new Client().post('/api/auth/login', { login: 'rizwana.k', password: 'fresh-pass' })).status, 200);
  assert.equal((await adminC.post(`/api/admin/donors/${id}/login`, { username: 'rizwana2' })).status, 409);
  // Blank fields go back to the rules.
  assert.deepEqual((await adminC.post(`/api/admin/donors/${id}/login`, {})).data.login, { username: 'rizwana', password: 'bua-or003' });

  const csv = await adminC.get('/api/admin/export/logins.csv');
  assert.match(csv.data, /Dr Rizwana Khan,,\+15049193426,rizwana,bua-or003,OR003/);

  // Bulk: donors without a login get one.
  const bulk = await adminC.post('/api/admin/donors/logins', {});
  assert.equal(bulk.status, 200);
  const { donors } = (await adminC.get('/api/admin/donors')).data;
  assert.ok(donors.filter((d) => d.active).every((d) => d.can_login));
});

test('rejected receipts notify the donor', async () => {
  const d = new Client();
  await d.post('/api/auth/login', { login: '03001234567', password: 'pass1234' });
  const before = (await d.get('/api/donor/notifications')).data.unread;
  const p = (await adminC.get('/api/admin/payments?q=IMP-1')).data.payments[0];
  // IMP-1 belongs to Bilal; use one of Ahmed's entries instead.
  const mine = (await d.get('/api/donor/payments')).data.payments.find((x) => x.status !== 'rejected');
  assert.ok(mine && p);
  await adminC.post(`/api/admin/payments/${mine.id}/reject`, { note: 'Receipt is from last month' });
  const n = (await d.get('/api/donor/notifications')).data;
  assert.equal(n.unread, before + 1);
  assert.equal(n.notifications[0].kind, 'rejected');
  assert.match(n.notifications[0].message, /Receipt is from last month/);
  await d.post('/api/donor/notifications/read', {});
  assert.equal((await d.get('/api/donor/notifications')).data.unread, 0);
  await adminC.post(`/api/admin/payments/${mine.id}/reopen`, {});
});

test('batches, ledgers, dashboard and deleting', async () => {
  // A verified payment for OR001 this month.
  const d = new Client();
  await d.post('/api/auth/login', { login: '03204000455', password: 'mine-now' });
  const pay = await d.req('POST', '/api/donor/payments', undefined, {
    form: receiptForm({ orphan_nos: 'OR005', months: month, amount: 7000, payment_date: today, ocr_text: ocr(today, '7,000', 'TX-BATCH-1'), ocr_confidence: 90, sharpness: 150 }, png(900, 900, 'batch')),
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  await adminC.post(`/api/admin/payments/${pay.data.payment.id}/verify`, {});

  const elig = (await adminC.get(`/api/admin/batches/eligible?month=${month}`)).data.orphans;
  const or5 = elig.find((o) => o.orphan_no === 'OR005');
  assert.equal(or5.amount, 7000);
  const created = await adminC.post('/api/admin/batches', { month, orphan_ids: [or5.id], area: 'Khan Younis' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const b = created.data.batch;
  assert.equal(b.status, 'ready');
  assert.equal(b.total, 7000);
  // An orphan-month can only be in one batch.
  assert.equal((await adminC.post('/api/admin/batches', { month, orphan_ids: [or5.id] })).status, 400);

  let dash = (await adminC.get(`/api/admin/dashboard?month=${month}`)).data;
  assert.equal(dash.batches.ready.total, 7000);
  const upd = await adminC.put(`/api/admin/batches/${b.id}`, { status: 'transferred', transfer_ref: 'WU-123' });
  assert.equal(upd.data.batch.transfer_amount, 7000);
  assert.equal(upd.data.batch.transfer_date, today);
  dash = (await adminC.get(`/api/admin/dashboard?month=${month}`)).data;
  assert.equal(dash.batches.transferred.total, 7000);
  assert.equal(dash.batches.ready.total, 0);
  assert.match((await adminC.get(`/api/admin/batches/${b.id}/export`)).data, /OR005/);

  // Ledgers
  const ledger = (await adminC.get(`/api/admin/orphans/${or5.id}/ledger`)).data;
  const row = ledger.rows.find((x) => x.transaction_ref === 'TX-BATCH-1');
  assert.equal(row.batch_status, 'transferred');
  assert.equal(ledger.totals.transferred, 7000);
  const donorId = (await adminC.get('/api/admin/donors')).data.donors.find((x) => x.username === '03204000455').id;
  const dl = (await adminC.get(`/api/admin/donors/${donorId}/ledger`)).data;
  assert.equal(dl.totals.verified, 7000);
  assert.match((await adminC.get(`/api/admin/donors/${donorId}/ledger.csv`)).data, /month,orphan_no,orphan_name/);

  // Deleting: needs confirmation when entries exist, then removes them.
  const del1 = await adminC.req('DELETE', `/api/admin/donors/${donorId}`);
  assert.equal(del1.status, 409);
  const del2 = await adminC.req('DELETE', `/api/admin/donors/${donorId}?with_entries=1`);
  assert.equal(del2.status, 200, JSON.stringify(del2.data));
  assert.equal((await adminC.get('/api/admin/payments?q=TX-BATCH-1&status=')).data.total, 0);
  const or2 = (await adminC.get('/api/admin/orphans')).data.orphans.find((o) => o.orphan_no === 'OR002');
  assert.equal((await adminC.req('DELETE', `/api/admin/orphans/${or2.id}`)).status, 200);
  assert.ok(!(await adminC.get('/api/admin/orphans')).data.orphans.some((o) => o.orphan_no === 'OR002'));
});
