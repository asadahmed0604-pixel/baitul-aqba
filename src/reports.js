import { weekRanges, weekOfMonth, monthLabel, normalizeAccount } from '../public/shared/receipt-parser.js';
import { officialAccountFor, round2, decorate } from './payments.js';

const statusFilter = (statuses) => {
  const list = (statuses || ['verified', 'pending']).filter((s) => ['pending', 'verified', 'rejected'].includes(s));
  return { sql: `p.status IN (${list.map(() => '?').join(',') || "''"})`, params: list };
};

export function paymentsInRange(db, from, to, statuses) {
  const f = statusFilter(statuses);
  const rows = db.prepare(`
    SELECT p.*, u.name AS donor_name, u.phone AS donor_phone, u.email AS donor_email
    FROM payments p JOIN users u ON u.id = p.donor_id
    WHERE p.payment_date BETWEEN ? AND ? AND ${f.sql}
    ORDER BY p.payment_date, p.id`).all(from, to, ...f.params);
  return rows.map((r) => decorate(db, r));
}

function beneficiaryKey(p) {
  return normalizeAccount(p.beneficiary_account) || `NAME:${(p.beneficiary_name || 'Unknown').toUpperCase()}`;
}

export function groupByBeneficiary(settings, payments) {
  const groups = new Map();
  for (const p of payments) {
    const key = beneficiaryKey(p);
    const official = officialAccountFor(settings, p.beneficiary_account);
    const g = groups.get(key) || {
      beneficiary_account: p.beneficiary_account || '',
      beneficiary_name: official?.title || p.beneficiary_name || 'Not identified',
      beneficiary_bank: official?.bank || p.beneficiary_bank || '',
      official: !!official,
      count: 0, total: 0, first_date: p.payment_date, last_date: p.payment_date, payment_ids: [],
    };
    g.count++;
    g.total = round2(g.total + p.amount);
    if (!g.beneficiary_bank && p.beneficiary_bank) g.beneficiary_bank = p.beneficiary_bank;
    if (p.payment_date < g.first_date) g.first_date = p.payment_date;
    if (p.payment_date > g.last_date) g.last_date = p.payment_date;
    g.payment_ids.push(p.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/** Week-wise report of receipts for a month, bucketed by the date on the receipt. */
export function weeklyReport(db, settings, month, statuses) {
  const weeks = weekRanges(month);
  const payments = paymentsInRange(db, weeks[0].from, weeks.at(-1).to, statuses);
  const out = weeks.map((w) => ({ ...w, count: 0, total: 0, advance_total: 0, current_total: 0, arrears_total: 0, entries: [] }));
  for (const p of payments) {
    const w = out[weekOfMonth(p.payment_date) - 1];
    w.count++;
    w.total = round2(w.total + p.amount);
    for (const a of p.allocations) {
      const bucket = a.month > month ? 'advance_total' : a.month < month ? 'arrears_total' : 'current_total';
      w[bucket] = round2(w[bucket] + a.amount);
    }
    w.entries.push(p);
  }
  for (const w of out) w.beneficiaries = groupByBeneficiary(settings, w.entries);
  const sum = (k) => round2(out.reduce((s, w) => s + w[k], 0));
  return {
    month,
    month_label: monthLabel(month),
    statuses: statusFilter(statuses).params,
    weeks: out,
    totals: {
      count: payments.length,
      total: sum('total'),
      current_total: sum('current_total'),
      advance_total: sum('advance_total'),
      arrears_total: sum('arrears_total'),
      donors: new Set(payments.map((p) => p.donor_id)).size,
      orphans: new Set(payments.flatMap((p) => p.orphan_nos)).size,
    },
    beneficiaries: groupByBeneficiary(settings, payments),
  };
}

/** Which orphans are covered for a month (including months paid in advance earlier). */
export function coverageReport(db, month, statuses) {
  const f = statusFilter(statuses);
  const orphans = db.prepare(`SELECT * FROM orphans WHERE status = 'active' ORDER BY orphan_no`).all();
  const paid = db.prepare(`
    SELECT pm.orphan_id, pm.amount, p.id AS payment_id, p.payment_date, p.status, u.name AS donor_name
    FROM payment_months pm JOIN payments p ON p.id = pm.payment_id JOIN users u ON u.id = p.donor_id
    WHERE pm.month = ? AND ${f.sql}`).all(month, ...f.params);
  const sponsors = db.prepare(`
    SELECT d.orphan_id, u.id, u.name, u.phone FROM donor_orphans d JOIN users u ON u.id = d.donor_id WHERE u.active = 1`).all();
  const rows = orphans.map((o) => {
    const ps = paid.filter((x) => x.orphan_id === o.id);
    const total = round2(ps.reduce((s, x) => s + x.amount, 0));
    let state = 'unpaid';
    if (total > 0) state = o.monthly_amount > 0 && total + 0.001 < o.monthly_amount ? 'partial' : 'paid';
    return {
      orphan_no: o.orphan_no, orphan_name: o.name, guardian_name: o.guardian_name, monthly_amount: o.monthly_amount,
      paid: total, state,
      paid_in_advance: ps.some((x) => x.payment_date.slice(0, 7) < month),
      payments: ps.map((x) => ({ id: x.payment_id, date: x.payment_date, status: x.status, donor: x.donor_name, amount: x.amount })),
      sponsors: sponsors.filter((s) => s.orphan_id === o.id).map((s) => ({ id: s.id, name: s.name, phone: s.phone })),
    };
  });
  return {
    month, month_label: monthLabel(month), rows,
    summary: {
      orphans: rows.length,
      paid: rows.filter((r) => r.state === 'paid').length,
      partial: rows.filter((r) => r.state === 'partial').length,
      unpaid: rows.filter((r) => r.state === 'unpaid').length,
      expected: round2(rows.reduce((s, r) => s + (r.monthly_amount || 0), 0)),
      received: round2(rows.reduce((s, r) => s + r.paid, 0)),
    },
  };
}

export function beneficiaryReport(db, settings, from, to, statuses) {
  const payments = paymentsInRange(db, from, to, statuses);
  return { from, to, groups: groupByBeneficiary(settings, payments), total: round2(payments.reduce((s, p) => s + p.amount, 0)), count: payments.length };
}
