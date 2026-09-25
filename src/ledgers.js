// Ledgers: every month allocation for one orphan or one donor, with review and transfer status.
import { fail } from './http.js';
import { round2 } from './payments.js';
import { BATCH_STATUS } from './batches.js';

const LINES = `
  SELECT pm.month, pm.amount, p.id AS entry_id, p.payment_date, p.status, p.transaction_ref, p.bank_name,
    p.beneficiary_name, p.beneficiary_account, p.beneficiary_bank, p.sender_name, p.sender_account, p.admin_note,
    p.amount AS receipt_amount, p.image_path, p.image_width, p.image_height, p.submitted_at, p.reviewed_at,
    (SELECT GROUP_CONCAT(DISTINCT x.month) FROM payment_months x WHERE x.payment_id = p.id) AS receipt_months,
    (SELECT GROUP_CONCAT(DISTINCT xo.orphan_no) FROM payment_months x JOIN orphans xo ON xo.id = x.orphan_id WHERE x.payment_id = p.id) AS receipt_orphans,
    u.id AS donor_id, u.name AS donor_name, u.phone AS donor_phone, u.sponsor_code,
    o.id AS orphan_id, o.orphan_no, o.name AS orphan_name, o.monthly_amount AS amount_billed,
    b.id AS batch_id, b.name AS batch_name, b.status AS batch_status, b.transfer_date
  FROM payment_months pm
  JOIN payments p ON p.id = pm.payment_id
  JOIN users u ON u.id = p.donor_id
  JOIN orphans o ON o.id = pm.orphan_id
  LEFT JOIN batch_items bi ON bi.orphan_id = pm.orphan_id AND bi.month = pm.month
  LEFT JOIN batches b ON b.id = bi.batch_id`;

function finish(lines) {
  let running = 0;
  const rows = lines.map((l) => {
    if (l.status === 'verified') running = round2(running + l.amount);
    return { ...l, verified_balance: running, batch_status_label: l.batch_status ? BATCH_STATUS[l.batch_status] : '' };
  });
  const sum = (st) => round2(rows.filter((r) => r.status === st).reduce((s, r) => s + r.amount, 0));
  return {
    rows,
    totals: {
      verified: sum('verified'), pending: sum('pending'), rejected: sum('rejected'),
      months_verified: new Set(rows.filter((r) => r.status === 'verified').map((r) => `${r.orphan_id}|${r.month}`)).size,
      transferred: round2(rows.filter((r) => r.status === 'verified' && r.batch_status === 'transferred').reduce((s, r) => s + r.amount, 0)),
    },
  };
}

export function orphanLedger(db, id) {
  const orphan = db.prepare('SELECT * FROM orphans WHERE id = ?').get(id);
  if (!orphan) fail(404, 'Orphan not found');
  const sponsors = db.prepare(`SELECT u.id, u.name, u.phone, u.sponsor_code FROM donor_orphans d JOIN users u ON u.id = d.donor_id WHERE d.orphan_id = ? ORDER BY u.name`).all(id);
  const lines = db.prepare(`${LINES} WHERE pm.orphan_id = ? ORDER BY pm.month, p.payment_date, p.id`).all(id);
  return { orphan, sponsors, ...finish(lines) };
}

export function donorLedger(db, id) {
  const donor = db.prepare(`SELECT id, name, phone, email, city, username, sponsor_code FROM users WHERE id = ? AND role = 'donor'`).get(id);
  if (!donor) fail(404, 'Donor not found');
  const orphans = db.prepare(`SELECT o.id, o.orphan_no, o.name FROM donor_orphans d JOIN orphans o ON o.id = d.orphan_id WHERE d.donor_id = ? ORDER BY o.orphan_no`).all(id);
  const lines = db.prepare(`${LINES} WHERE p.donor_id = ? ORDER BY p.payment_date, p.id, o.orphan_no, pm.month`).all(id);
  return { donor, orphans, ...finish(lines) };
}

/** Every orphan-month paid, optionally limited to a receipt-date range (for the full export). */
export function allLines(db, { from = '0000-01-01', to = '9999-12-31' } = {}) {
  return finish(db.prepare(`${LINES} WHERE p.payment_date BETWEEN ? AND ? ORDER BY pm.month, o.orphan_no, p.payment_date, p.id`).all(from, to));
}

export const LEDGER_COLUMNS = [
  { key: 'month', label: 'month' }, { key: 'orphan_no', label: 'orphan_no' }, { key: 'orphan_name', label: 'orphan_name' },
  { key: 'donor_name', label: 'donor' }, { key: 'sponsor_code', label: 'sp_code' }, { key: 'amount', label: 'amount' },
  { key: 'status', label: 'status' }, { key: 'verified_balance', label: 'verified_running_total' },
  { key: 'entry_id', label: 'entry_id' }, { key: 'payment_date', label: 'receipt_date' }, { key: 'transaction_ref', label: 'transaction_ref' },
  { key: 'beneficiary_account', label: 'paid_to_account' }, { key: 'batch_name', label: 'batch' },
  { key: 'batch_status_label', label: 'transfer_status' }, { key: 'transfer_date', label: 'transfer_date' }, { key: 'admin_note', label: 'note' },
];
