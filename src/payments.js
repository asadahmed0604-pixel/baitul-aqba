// Core donation-entry logic: validation of receipts, month allocation, persistence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, imageInfo } from './http.js';
import { tx, audit } from './db.js';
import {
  parseReceipt, parseDates, accountsMatch, normalizeAccount, monthOf, addMonths, todayIn, monthLabel,
} from '../public/shared/receipt-parser.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function clock(settings) {
  const today = todayIn(settings.timezone);
  return { today, month: monthOf(today) };
}

export const round2 = (n) => Math.round(n * 100) / 100;

/** Split an amount evenly across allocations; the last one absorbs rounding. */
export function splitAmount(total, count) {
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? cents - each * (count - 1) : each) / 100);
}

export function parseList(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (v == null || v === '') return [];
  const s = String(v).trim();
  if (s.startsWith('[')) { try { return parseList(JSON.parse(s)); } catch { /* fall through */ } }
  return s.split(/[;,|\n]+/).map((x) => x.trim()).filter(Boolean);
}

/** Normalise "Sep 2026", "09/2026", "2026-9" etc. to YYYY-MM. */
export function normalizeMonth(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  const d = parseDates(`1 ${s}`)[0];
  return d ? d.iso.slice(0, 7) : s;
}

const flag = (code, message) => ({ code, message });

function findDuplicateRef(db, ref, excludeId) {
  if (!ref) return null;
  return db.prepare(`SELECT id FROM payments WHERE status != 'rejected' AND UPPER(REPLACE(transaction_ref, ' ', '')) = ? AND id != ?`)
    .get(ref.toUpperCase().replace(/\s/g, ''), excludeId ?? -1);
}

function coverageConflicts(db, allocations, excludePaymentId) {
  const stmt = db.prepare(`
    SELECT pm.payment_id, o.orphan_no, pm.month FROM payment_months pm
    JOIN payments p ON p.id = pm.payment_id JOIN orphans o ON o.id = pm.orphan_id
    WHERE pm.orphan_id = ? AND pm.month = ? AND p.status != 'rejected' AND p.id != ?`);
  const out = [];
  for (const a of allocations) {
    const hit = stmt.get(a.orphan.id, a.month, excludePaymentId ?? -1);
    if (hit) out.push(`${hit.orphan_no} ${monthLabel(hit.month)} (entry #${hit.payment_id})`);
  }
  return out;
}

/**
 * Validate and build the allocation list (orphan x month) for a payment.
 * `strict` applies the donor-facing month window.
 */
export function buildAllocations(db, settings, { orphanNos, months, amount, strict }) {
  const nos = [...new Set(parseList(orphanNos).map((s) => s.toUpperCase()))];
  if (!nos.length) fail(400, 'Enter at least one orphan number');
  const orphans = nos.map((no) => {
    const o = db.prepare('SELECT * FROM orphans WHERE orphan_no = ?').get(no);
    if (!o) fail(400, `Orphan number ${no} was not found. Please check the number.`);
    if (strict && o.status !== 'active') fail(400, `Orphan number ${no} is not active`);
    return o;
  });

  const ms = [...new Set(parseList(months).map(normalizeMonth))].sort();
  if (!ms.length) fail(400, 'Select at least one month this payment is for');
  for (const m of ms) if (!MONTH_RE.test(m)) fail(400, `Invalid month "${m}" (use YYYY-MM)`);
  if (strict) {
    const { month } = clock(settings);
    const earliest = addMonths(month, -settings.maxArrearsMonths);
    const latest = addMonths(month, settings.maxAdvanceMonths);
    for (const m of ms) {
      if (m < earliest) fail(400, `${monthLabel(m)} is too far in the past (arrears allowed up to ${monthLabel(earliest)})`);
      if (m > latest) fail(400, `${monthLabel(m)} is too far ahead (advance allowed up to ${monthLabel(latest)})`);
    }
  }

  const pairs = [];
  for (const o of orphans) for (const m of ms) pairs.push({ orphan: o, month: m });
  const amounts = splitAmount(amount, pairs.length);
  return pairs.map((p, i) => ({ ...p, amount: amounts[i] }));
}

function inspectImage(settings, file, strict) {
  if (!file) {
    if (strict) fail(400, 'Please attach a clear photo or screenshot of the bank receipt');
    return null;
  }
  const info = imageInfo(file.data);
  if (!info) fail(400, 'Receipt must be a JPG, PNG or WebP image');
  if (file.data.length > settings.maxUploadMb * 1024 * 1024) fail(400, `Receipt image is larger than ${settings.maxUploadMb} MB`);
  if (strict && info.width && Math.min(info.width, info.height) < settings.minImageSide) {
    fail(422, `Receipt image is too small (${info.width}x${info.height}). Upload a clear, full-size screenshot or photo (at least ${settings.minImageSide}px).`);
  }
  return { ...info, hash: crypto.createHash('sha256').update(file.data).digest('hex'), data: file.data };
}

/**
 * Receipt quality and date checks. Returns flags for review; throws on hard failures
 * (only when `strict`, i.e. donor submissions).
 */
export function checkReceipt(settings, input, strict) {
  const flags = [];
  const { today, month } = clock(settings);
  const date = input.payment_date;

  if (strict && settings.requireReceiptDateInCurrentMonth) {
    if (monthOf(date) !== month) {
      fail(422, `Only receipts dated in the current month (${monthLabel(month)}) are accepted. This receipt is dated ${date}.`);
    }
    if (date > today) fail(422, 'Receipt date cannot be in the future');
  } else if (monthOf(date) !== monthOf(input.submitted_on || today)) {
    flags.push(flag('receipt_not_current_month', `Receipt dated ${date} is outside the month it was entered`));
  }

  const ocrRan = input.ocr_text != null && String(input.ocr_text).trim() !== '';
  const conf = input.ocr_confidence === '' || input.ocr_confidence == null ? null : Number(input.ocr_confidence);
  const sharp = input.sharpness === '' || input.sharpness == null ? null : Number(input.sharpness);

  if (strict && sharp != null && Number.isFinite(sharp) && sharp < settings.minSharpness) {
    fail(422, 'The receipt image is blurry. Please upload a clear screenshot or a sharper photo of the receipt.');
  }
  if (strict && ocrRan && conf != null && Number.isFinite(conf) && conf < settings.minOcrConfidence) {
    fail(422, `The receipt text could not be read clearly (clarity ${Math.round(conf)}%). Please upload a clearer image.`);
  }
  if (!ocrRan && input.has_image) flags.push(flag('ocr_not_run', 'Automatic receipt reading was not available; check the image manually'));

  const text = [input.ocr_text, input.receipt_text].filter(Boolean).join('\n');
  const parsed = parseReceipt(text);
  if (ocrRan) {
    const ocrDates = parseDates(input.ocr_text).map((d) => d.iso);
    if (!ocrDates.length) {
      flags.push(flag('no_date_on_receipt', 'No date could be read on the receipt image'));
    } else {
      const inMonth = ocrDates.filter((d) => monthOf(d) === monthOf(date));
      if (!inMonth.length) {
        if (strict && settings.rejectWhenOcrDatesOutsideMonth) {
          fail(422, `The receipt image shows ${ocrDates.join(', ')}, which is not in the current month (${monthLabel(month)}). Only current-month bank receipts are accepted.`);
        }
        flags.push(flag('receipt_date_outside_month', `Receipt image shows ${ocrDates.join(', ')}`));
      } else if (!ocrDates.includes(date)) {
        flags.push(flag('date_mismatch', `Entered date ${date} differs from the receipt (${ocrDates.join(', ')})`));
      }
    }
    const ocrAmount = parseReceipt(input.ocr_text).amount;
    if (ocrAmount && Math.abs(ocrAmount - input.amount) > 0.5) {
      flags.push(flag('amount_mismatch', `Entered amount ${input.amount} differs from receipt amount ${ocrAmount}`));
    }
  }
  return { flags, parsed };
}

function beneficiaryFlags(settings, account) {
  if (!account) return [flag('beneficiary_not_detected', 'Beneficiary account could not be identified')];
  const official = settings.officialAccounts || [];
  if (official.length && !official.some((a) => accountsMatch(a.account, account))) {
    return [flag('unknown_beneficiary_account', `Paid to ${account}, which is not one of the foundation's registered accounts`)];
  }
  return [];
}

export function officialAccountFor(settings, account) {
  return (settings.officialAccounts || []).find((a) => accountsMatch(a.account, account)) || null;
}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

/**
 * Create a payment entry.
 * source: 'donor' (strict current-month rules), 'admin' (manual entry), 'import'.
 */
export function createPayment(db, settings, uploadsDir, { donorId, source, fields, file, actorId }) {
  const strict = source === 'donor';
  const amount = round2(Number(String(fields.amount || '').replace(/,/g, '')));
  if (!(amount > 0)) fail(400, 'Enter the amount paid');
  const payment_date = str(fields.payment_date, 10);
  if (!DATE_RE.test(payment_date) || Number.isNaN(Date.parse(payment_date))) fail(400, 'Enter the date shown on the receipt');

  const allocations = buildAllocations(db, settings, { orphanNos: fields.orphan_nos, months: fields.months, amount, strict });
  const image = inspectImage(settings, file, strict);

  if (image) {
    const dup = db.prepare(`SELECT id FROM payments WHERE image_hash = ? AND status != 'rejected'`).get(image.hash);
    if (dup) fail(409, `This receipt image was already submitted (entry #${dup.id})`);
  }

  const { flags, parsed } = checkReceipt(settings, {
    payment_date, amount,
    ocr_text: fields.ocr_text, ocr_confidence: fields.ocr_confidence, sharpness: fields.sharpness,
    receipt_text: fields.receipt_text, has_image: !!image, submitted_on: fields.submitted_on,
  }, strict);

  const rec = {
    bank_name: str(fields.bank_name, 120) || parsed.banks[0] || '',
    transaction_ref: str(fields.transaction_ref, 80) || parsed.transactionRef,
    sender_name: str(fields.sender_name, 120) || parsed.senderName,
    sender_account: normalizeAccount(fields.sender_account) || parsed.senderAccount,
    beneficiary_name: str(fields.beneficiary_name, 160) || parsed.beneficiaryName,
    beneficiary_account: normalizeAccount(fields.beneficiary_account) || parsed.beneficiaryAccount,
    beneficiary_bank: str(fields.beneficiary_bank, 120) || parsed.beneficiaryBank,
  };
  flags.push(...beneficiaryFlags(settings, rec.beneficiary_account));
  if (!rec.transaction_ref) flags.push(flag('no_transaction_ref', 'No transaction ID / reference number'));

  const dupRef = findDuplicateRef(db, rec.transaction_ref);
  if (dupRef) {
    if (strict) fail(409, `A receipt with transaction ID ${rec.transaction_ref} was already submitted (entry #${dupRef.id})`);
    flags.push(flag('duplicate_transaction_ref', `Same transaction ID as entry #${dupRef.id}`));
  }
  const conflicts = coverageConflicts(db, allocations);
  if (conflicts.length) flags.push(flag('month_already_covered', `Already paid: ${conflicts.join('; ')}`));

  const status = source === 'import' && ['pending', 'verified', 'rejected'].includes(fields.status) ? fields.status : 'pending';

  let savedFile = null;
  try {
    return tx(db, () => {
      const r = db.prepare(`
        INSERT INTO payments (donor_id, amount, payment_date, bank_name, transaction_ref, sender_name, sender_account,
          beneficiary_name, beneficiary_account, beneficiary_bank, receipt_text, ocr_text, ocr_confidence, sharpness,
          image_hash, image_width, image_height, donor_note, admin_note, flags, status, source, submitted_at, reviewed_by, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)`).run(
        donorId, amount, payment_date, rec.bank_name, rec.transaction_ref, rec.sender_name, rec.sender_account,
        rec.beneficiary_name, rec.beneficiary_account, rec.beneficiary_bank, str(fields.receipt_text, 5000),
        str(fields.ocr_text, 10000) || null,
        fields.ocr_confidence === '' || fields.ocr_confidence == null ? null : Number(fields.ocr_confidence),
        fields.sharpness === '' || fields.sharpness == null ? null : Number(fields.sharpness),
        image?.hash ?? null, image?.width ?? null, image?.height ?? null,
        str(fields.donor_note, 1000), str(fields.admin_note, 1000), JSON.stringify(flags), status, source,
        str(fields.submitted_at, 19) || null,
        status !== 'pending' ? actorId ?? null : null, status !== 'pending' ? new Date().toISOString() : null,
      );
      const id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO payment_months (payment_id, orphan_id, month, amount) VALUES (?, ?, ?, ?)');
      const link = db.prepare('INSERT OR IGNORE INTO donor_orphans (donor_id, orphan_id) VALUES (?, ?)');
      for (const a of allocations) {
        ins.run(id, a.orphan.id, a.month, a.amount);
        link.run(donorId, a.orphan.id);
      }
      if (image) {
        const dir = path.join(uploadsDir, payment_date.slice(0, 7));
        fs.mkdirSync(dir, { recursive: true });
        const rel = path.join(payment_date.slice(0, 7), `${id}-${image.hash.slice(0, 12)}.${image.type === 'jpeg' ? 'jpg' : image.type}`);
        fs.writeFileSync(path.join(uploadsDir, rel), image.data);
        savedFile = path.join(uploadsDir, rel);
        db.prepare('UPDATE payments SET image_path = ? WHERE id = ?').run(rel, id);
      }
      audit(db, actorId ?? donorId, 'payment.create', 'payment', id, { source, amount, flags: flags.map((f) => f.code) });
      return getPayment(db, id);
    });
  } catch (e) {
    if (savedFile) fs.rmSync(savedFile, { force: true });
    throw e;
  }
}

export function getPayment(db, id) {
  const p = db.prepare(`
    SELECT p.*, u.name AS donor_name, u.email AS donor_email, u.phone AS donor_phone, r.name AS reviewed_by_name
    FROM payments p JOIN users u ON u.id = p.donor_id LEFT JOIN users r ON r.id = p.reviewed_by WHERE p.id = ?`).get(id);
  if (!p) return null;
  return decorate(db, p);
}

export function decorate(db, p) {
  const months = db.prepare(`
    SELECT pm.month, pm.amount, o.orphan_no, o.name AS orphan_name FROM payment_months pm
    JOIN orphans o ON o.id = pm.orphan_id WHERE pm.payment_id = ? ORDER BY o.orphan_no, pm.month`).all(p.id);
  let flags = [];
  try { flags = JSON.parse(p.flags || '[]'); } catch { /* ignore */ }
  return {
    ...p,
    flags,
    has_image: !!p.image_path,
    allocations: months,
    orphan_nos: [...new Set(months.map((m) => m.orphan_no))],
    months: [...new Set(months.map((m) => m.month))].sort(),
  };
}

/** Admin edit of an existing entry (fields and/or allocation). */
export function updatePayment(db, settings, id, fields, actorId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!p) fail(404, 'Entry not found');
  const next = {
    amount: fields.amount != null ? round2(Number(String(fields.amount).replace(/,/g, ''))) : p.amount,
    payment_date: fields.payment_date != null ? str(fields.payment_date, 10) : p.payment_date,
  };
  if (!(next.amount > 0)) fail(400, 'Amount must be greater than zero');
  if (!DATE_RE.test(next.payment_date)) fail(400, 'Invalid date');
  const textCols = ['bank_name', 'transaction_ref', 'sender_name', 'beneficiary_name', 'beneficiary_bank', 'admin_note'];
  const acctCols = ['sender_account', 'beneficiary_account'];

  return tx(db, () => {
    const sets = ['amount = ?', 'payment_date = ?'];
    const vals = [next.amount, next.payment_date];
    for (const c of textCols) if (fields[c] != null) { sets.push(`${c} = ?`); vals.push(str(fields[c], 500)); }
    for (const c of acctCols) if (fields[c] != null) { sets.push(`${c} = ?`); vals.push(normalizeAccount(fields[c])); }
    db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

    const cur = getPayment(db, id);
    if (fields.orphan_nos != null || fields.months != null || fields.amount != null) {
      const allocations = buildAllocations(db, settings, {
        orphanNos: fields.orphan_nos ?? cur.orphan_nos, months: fields.months ?? cur.months, amount: next.amount, strict: false,
      });
      db.prepare('DELETE FROM payment_months WHERE payment_id = ?').run(id);
      const ins = db.prepare('INSERT INTO payment_months (payment_id, orphan_id, month, amount) VALUES (?, ?, ?, ?)');
      const link = db.prepare('INSERT OR IGNORE INTO donor_orphans (donor_id, orphan_id) VALUES (?, ?)');
      for (const a of allocations) { ins.run(id, a.orphan.id, a.month, a.amount); link.run(p.donor_id, a.orphan.id); }
    }
    // Refresh the automatic flags that depend on editable fields.
    const after = getPayment(db, id);
    const keep = after.flags.filter((f) => !['beneficiary_not_detected', 'unknown_beneficiary_account', 'no_transaction_ref', 'month_already_covered'].includes(f.code));
    keep.push(...beneficiaryFlags(settings, after.beneficiary_account));
    if (!after.transaction_ref) keep.push(flag('no_transaction_ref', 'No transaction ID / reference number'));
    const conflicts = coverageConflicts(db, after.allocations.map((a) => ({
      orphan: db.prepare('SELECT id FROM orphans WHERE orphan_no = ?').get(a.orphan_no), month: a.month,
    })), id);
    if (conflicts.length) keep.push(flag('month_already_covered', `Already paid: ${conflicts.join('; ')}`));
    db.prepare('UPDATE payments SET flags = ? WHERE id = ?').run(JSON.stringify(keep), id);
    audit(db, actorId, 'payment.update', 'payment', id, fields);
    return getPayment(db, id);
  });
}

export function setStatus(db, id, status, note, actorId) {
  const p = db.prepare('SELECT id FROM payments WHERE id = ?').get(id);
  if (!p) fail(404, 'Entry not found');
  db.prepare(`UPDATE payments SET status = ?, admin_note = COALESCE(?, admin_note), reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(status, note ? String(note).slice(0, 1000) : null, actorId, id);
  audit(db, actorId, `payment.${status}`, 'payment', id, note ? { note } : null);
  return getPayment(db, id);
}

export function deletePayment(db, uploadsDir, id, actorId) {
  const p = db.prepare('SELECT id, image_path FROM payments WHERE id = ?').get(id);
  if (!p) fail(404, 'Entry not found');
  tx(db, () => {
    db.prepare('DELETE FROM payment_months WHERE payment_id = ?').run(id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    audit(db, actorId, 'payment.delete', 'payment', id, null);
  });
  if (p.image_path) fs.rmSync(path.join(uploadsDir, p.image_path), { force: true });
}
