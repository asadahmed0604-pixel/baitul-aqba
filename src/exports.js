// Shared export columns (CSV and Excel), signed receipt links and receipt pictures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accountsMatch } from '../public/shared/receipt-parser.js';
import { localPkMobile } from './logins.js';

const LINK_DAYS = 180;

/** Receipt links that open without signing in (for spreadsheets), valid for LINK_DAYS. */
export function receiptLinks(secret) {
  const sign = (id, exp) => crypto.createHmac('sha256', secret).update(`receipt:${id}:${exp}`).digest('base64url').slice(0, 32);
  return {
    url(base, id) {
      const exp = Math.floor(Date.now() / 1000) + LINK_DAYS * 86400;
      return `${base}/api/receipt/${id}?e=${exp}&s=${sign(id, exp)}`;
    },
    verify(id, exp, sig) {
      if (!/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000) return false;
      const want = sign(id, exp);
      return typeof sig === 'string' && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    },
  };
}

export function baseUrl(req) {
  const proto = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : process.env.SECURE_COOKIES === '1' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

/** Loads the receipt image for a row, for embedding in Excel (JPEG and PNG only). */
export function pictureLoader(uploadsDir) {
  return (row) => {
    if (!row.image_path) return null;
    const ext = path.extname(row.image_path).slice(1).toLowerCase();
    if (!['jpg', 'jpeg', 'png'].includes(ext)) return null;
    try {
      return { key: row.entry_id ?? row.id, data: fs.readFileSync(path.join(uploadsDir, row.image_path)), type: ext === 'png' ? 'png' : 'jpeg', width: row.image_width, height: row.image_height };
    } catch { return null; }
  };
}

const mobile = (phone) => localPkMobile(phone) || phone || '';
const officialFor = (settings) => (acct) => {
  if (!acct) return '';
  return (settings.officialAccounts || []).some((a) => accountsMatch(a.account, acct)) ? 'Yes' : 'NO';
};
const months = (s) => String(s || '').split(',').filter(Boolean).sort().join('; ');
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * One row per orphan-month paid: who paid, which month, when, billed vs paid, beneficiary, receipt.
 * `link(entryId)` builds the receipt link.
 */
export function ledgerColumns(settings, link) {
  const official = officialFor(settings);
  return [
    { label: 'Month paid for', width: 12, value: (r) => r.month },
    { label: 'Orphan code', width: 11, value: (r) => r.orphan_no },
    { label: 'Orphan name', width: 26, value: (r) => r.orphan_name },
    { label: 'Donor', width: 22, value: (r) => r.donor_name },
    { label: 'Donor mobile', width: 15, value: (r) => mobile(r.donor_phone) },
    { label: 'SP code', width: 9, value: (r) => r.sponsor_code || '' },
    { label: 'Amount billed', width: 11, value: (r) => (r.amount_billed ? r.amount_billed : '') },
    { label: 'Amount paid', width: 11, value: (r) => r.amount },
    { label: 'Difference', width: 10, value: (r) => (r.amount_billed ? round2(r.amount - r.amount_billed) : '') },
    { label: 'Status', width: 10, value: (r) => r.status },
    { label: 'Verified running total', width: 12, value: (r) => r.verified_balance },
    { label: 'Payment date (receipt)', width: 13, value: (r) => r.payment_date },
    { label: 'Entry #', width: 8, value: (r) => r.entry_id },
    { label: 'Receipt total', width: 11, value: (r) => r.receipt_amount },
    { label: 'Receipt covers months', width: 18, value: (r) => months(r.receipt_months) },
    { label: 'Receipt covers orphans', width: 16, value: (r) => months(r.receipt_orphans) },
    { label: 'Transaction ID', width: 16, value: (r) => r.transaction_ref || '' },
    { label: 'Paid from bank', width: 14, value: (r) => r.bank_name || '' },
    { label: 'Sender name', width: 18, value: (r) => r.sender_name || '' },
    { label: 'Sender account', width: 18, value: (r) => r.sender_account || '' },
    { label: 'Beneficiary name', width: 22, value: (r) => r.beneficiary_name || '' },
    { label: 'Beneficiary account / IBAN', width: 26, value: (r) => r.beneficiary_account || '' },
    { label: 'Beneficiary bank', width: 14, value: (r) => r.beneficiary_bank || '' },
    { label: 'Foundation account?', width: 11, value: (r) => official(r.beneficiary_account) },
    { label: 'Transfer batch', width: 20, value: (r) => r.batch_name || '' },
    { label: 'Transfer status', width: 20, value: (r) => r.batch_status_label || '' },
    { label: 'Transfer date', width: 12, value: (r) => r.transfer_date || '' },
    { label: 'Management note', width: 24, value: (r) => r.admin_note || '' },
    { label: 'Receipt link', width: 14, value: (r) => (r.image_path ? { text: 'View receipt', link: link(r.entry_id) } : '') },
    { label: 'Receipt picture', width: 19, value: () => '' },
  ];
}

/** One row per receipt (donation entry). */
export function paymentColumns(settings, link) {
  const official = officialFor(settings);
  return [
    { label: 'Entry #', width: 8, value: (p) => p.id },
    { label: 'Payment date (receipt)', width: 13, value: (p) => p.payment_date },
    { label: 'Donor', width: 22, value: (p) => p.donor_name },
    { label: 'Donor mobile', width: 15, value: (p) => mobile(p.donor_phone) },
    { label: 'Donor email', width: 20, value: (p) => p.donor_email || '' },
    { label: 'SP code', width: 9, value: (p) => p.sponsor_code || '' },
    { label: 'Orphans', width: 16, value: (p) => p.orphan_nos.join('; ') },
    { label: 'Months paid for', width: 18, value: (p) => p.months.join('; ') },
    { label: 'Paid per orphan-month', width: 26, value: (p) => p.allocations.map((a) => `${a.orphan_no} ${a.month}: ${a.amount}`).join('; ') },
    { label: 'Amount billed', width: 11, value: (p) => (p.amount_billed ? p.amount_billed : '') },
    { label: 'Amount paid', width: 11, value: (p) => p.amount },
    { label: 'Difference', width: 10, value: (p) => (p.amount_billed ? round2(p.amount - p.amount_billed) : '') },
    { label: 'Status', width: 10, value: (p) => p.status },
    { label: 'Transaction ID', width: 16, value: (p) => p.transaction_ref || '' },
    { label: 'Paid from bank', width: 14, value: (p) => p.bank_name || '' },
    { label: 'Sender name', width: 18, value: (p) => p.sender_name || '' },
    { label: 'Sender account', width: 18, value: (p) => p.sender_account || '' },
    { label: 'Beneficiary name', width: 22, value: (p) => p.beneficiary_name || '' },
    { label: 'Beneficiary account / IBAN', width: 26, value: (p) => p.beneficiary_account || '' },
    { label: 'Beneficiary bank', width: 14, value: (p) => p.beneficiary_bank || '' },
    { label: 'Foundation account?', width: 11, value: (p) => official(p.beneficiary_account) },
    { label: 'Warnings', width: 26, value: (p) => p.flags.map((f) => f.message).join('; ') },
    { label: 'Donor note', width: 20, value: (p) => p.donor_note || '' },
    { label: 'Management note', width: 22, value: (p) => p.admin_note || '' },
    { label: 'Submitted', width: 17, value: (p) => p.submitted_at },
    { label: 'Reviewed', width: 17, value: (p) => p.reviewed_at || '' },
    { label: 'Source', width: 8, value: (p) => p.source },
    { label: 'Receipt link', width: 14, value: (p) => (p.image_path ? { text: 'View receipt', link: link(p.id) } : '') },
    { label: 'Receipt picture', width: 19, value: () => '' },
  ];
}

/** Adapt columns for CSV: links become plain URLs; the picture column is left out. */
export const forCsv = (columns) => columns.filter((c) => c.label !== 'Receipt picture').map((c) => ({
  label: c.label,
  value: (r) => { const v = c.value(r); return v && typeof v === 'object' ? v.link : v; },
}));
