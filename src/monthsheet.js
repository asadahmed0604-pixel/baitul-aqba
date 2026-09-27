// "Monthly payments sheet": one row per orphan code, a column per month (September, October, …)
// with the amount paid for that month, and optionally an "Onwards" column holding the total paid in
// advance for the months after it. Example: Advance_final_OCt_3.xlsx.
//
// Each row becomes donation entries:
//   - every month before "Onwards" (e.g. September) is its own entry;
//   - the months after it are one advance entry when their amounts are equal, otherwise one each.
// Rows that need a human look (Onwards total doesn't match the months, an identical row repeated)
// are kept but marked for review.
import crypto from 'node:crypto';
import { addMonths } from '../public/shared/receipt-parser.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const monthNumber = (key) => {
  const k = String(key).toLowerCase().replace(/[^a-z]/g, '');
  const i = MONTHS.indexOf(k) >= 0 ? MONTHS.indexOf(k) : SHORT.indexOf(k.slice(0, 3)) >= 0 && k.length <= 4 ? SHORT.indexOf(k.slice(0, 3)) : -1;
  return i >= 0 ? i + 1 : null;
};
const num = (v) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

/** Is this a monthly payments sheet? (an orphan-code column plus at least two month columns) */
export function isMonthSheet(rows) {
  const keys = Object.keys(rows[0] || {});
  return keys.some((k) => /orphan_code|^code$|orphan_no/.test(k)) && keys.filter((k) => monthNumber(k)).length >= 2;
}

/**
 * Work out which calendar month each month column means. The first month column is placed within
 * 5 months before / 6 months after `currentMonth`; later columns follow on (Dec -> Jan moves the year).
 */
export function monthColumns(keys, currentMonth) {
  const [cy, cm] = currentMonth.split('-').map(Number);
  const out = [];
  let prev = null;
  for (const key of keys) {
    if (key === 'onwards' || /^onward|^advance$/.test(key)) { out.push({ key, onwards: true }); continue; }
    const m = monthNumber(key);
    if (!m) continue;
    let ym;
    if (!prev) {
      let y = cy;
      const diff = (y * 12 + m) - (cy * 12 + cm);
      if (diff < -5) y += 1; else if (diff > 6) y -= 1;
      ym = `${y}-${String(m).padStart(2, '0')}`;
    } else {
      ym = addMonths(prev, 1);
      while (Number(ym.slice(5)) !== m) ym = addMonths(ym, 1);
    }
    prev = ym;
    out.push({ key, month: ym });
  }
  return out;
}

export function expandMonthSheet(rows, { currentMonth, sheetName = 'sheet' }) {
  const keys = Object.keys(rows[0] || {});
  const cols = monthColumns(keys, currentMonth);
  const codeKey = keys.find((k) => /orphan_code/.test(k)) || keys.find((k) => k === 'code' || k === 'orphan_no');
  const nameKey = keys.find((k) => /orphan_name/.test(k)) || keys.find((k) => k === 'name');
  const onwardsIdx = cols.findIndex((c) => c.onwards);
  const specs = [], skipped = [], seen = new Map();

  for (const row of rows) {
    const code = String(row[codeKey] || '').trim().toUpperCase();
    const rowNo = row._row;
    if (!code) {
      if (cols.some((c) => row[c.key] && num(row[c.key]))) skipped.push({ row: rowNo, reason: 'No orphan code (probably a total row)' });
      continue;
    }
    const notes = [];
    const cells = [];
    cols.forEach((c, i) => {
      if (c.onwards) return;
      const v = num(row[c.key]);
      if (Number.isNaN(v)) { notes.push(`"${row[c.key]}" in ${c.key} ignored`); return; }
      if (v > 0) cells.push({ ...c, amount: v, before: onwardsIdx >= 0 && i < onwardsIdx });
    });
    if (!cells.length) {
      const text = cols.map((c) => row[c.key]).filter((v) => v && Number.isNaN(num(v)));
      skipped.push({ row: rowNo, reason: `${code}: no amounts${text.length ? ` (says "${text.join('", "')}")` : ''}` });
      continue;
    }
    const groups = [];
    for (const c of cells.filter((x) => x.before || onwardsIdx < 0)) groups.push([c]);
    const after = cells.filter((x) => !x.before && onwardsIdx >= 0);
    if (after.length) {
      if (after.every((c) => c.amount === after[0].amount)) groups.push(after);
      else after.forEach((c) => groups.push([c]));
    }
    // Check the "Onwards" total against the months filled in after it.
    const onwards = onwardsIdx >= 0 ? num(row[cols[onwardsIdx].key]) : null;
    const afterTotal = after.reduce((s, c) => s + c.amount, 0);
    const review = [];
    if (onwards && !Number.isNaN(onwards) && Math.abs(onwards - afterTotal) > 1) {
      review.push(`"Onwards" says ${onwards} but the months filled in add up to ${afterTotal}`);
    }
    for (const g of groups) {
      const months = g.map((c) => c.month);
      const amount = Math.round(g.reduce((s, c) => s + c.amount, 0) * 100) / 100;
      const sig = `${code}|${months.join(',')}|${amount}`;
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);
      const flags = [...review];
      if (n > 1) flags.push(`Same orphan, months and amount as an earlier row of the sheet — check it isn't entered twice`);
      specs.push({
        row: rowNo, orphan_no: code, orphan_name: String(row[nameKey] || '').trim(), months, amount,
        // Stable reference so importing the same sheet again doesn't duplicate entries.
        ref: `SHEET-${crypto.createHash('sha1').update(`${sig}|${n}`).digest('hex').slice(0, 10).toUpperCase()}`,
        review: flags, notes,
        note: `From ${sheetName}, row ${rowNo}${notes.length ? ` (${notes.join('; ')})` : ''}${flags.length ? `. Check: ${flags.join('; ')}` : ''}`,
      });
    }
  }
  return { specs, skipped, columns: cols };
}
