// Receipt text parsing shared by the browser (donor/admin OCR) and the server
// (validation). Pure functions only: no DOM, no Node APIs.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

export const KNOWN_BANKS = [
  'Meezan Bank', 'Habib Bank', 'HBL', 'United Bank', 'UBL', 'MCB Islamic', 'MCB', 'Allied Bank', 'ABL',
  'Bank Alfalah', 'Bank Al Habib', 'Bank AL Habib', 'Faysal Bank', 'Askari Bank', 'Standard Chartered',
  'JS Bank', 'Soneri Bank', 'Summit Bank', 'Silk Bank', 'BankIslami', 'Bank Islami', 'Dubai Islamic',
  'Al Baraka', 'National Bank', 'NBP', 'Bank of Punjab', 'BOP', 'Sindh Bank', 'First Women Bank',
  'Habib Metro', 'HabibMetro', 'Bank of Khyber', 'Samba Bank', 'Citi', 'JazzCash', 'Easypaisa',
  'EasyPaisa', 'SadaPay', 'NayaPay', 'Raast', 'Konnect', 'UPaisa', 'Zindigi',
];

const pad = (n) => String(n).padStart(2, '0');

export function isoDate(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. 31/02
  return `${y}-${pad(m)}-${pad(d)}`;
}

const fullYear = (y) => (y < 100 ? 2000 + y : y);

/** Find every calendar date mentioned in the text. Numeric dates default to day/month/year. */
export function parseDates(text) {
  const src = String(text || '');
  const found = [];
  const push = (iso, raw, index) => {
    if (iso && !found.some((f) => f.index === index)) found.push({ iso, raw: raw.trim(), index });
  };
  let m;

  // 2026-09-22 / 2026/09/22
  const ymd = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = ymd.exec(src))) push(isoDate(+m[1], +m[2], +m[3]), m[0], m.index);

  // 22/09/2026, 22-09-26, 09/22/2026 (only when unambiguous)
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g;
  while ((m = dmy.exec(src))) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    const iso = b > 12 && a <= 12 ? isoDate(y, a, b) : isoDate(y, b, a);
    push(iso, m[0], m.index);
  }

  // 22 Sep 2026, 22-Sep-2026, 22nd September, 2026
  const dMonY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.,]*(${MONTH_RE})[a-z]*[\\s\\-/.,']*(\\d{4}|\\d{2})\\b`, 'gi');
  while ((m = dMonY.exec(src))) push(isoDate(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]), m[0], m.index);

  // Sep 22, 2026 / September 22nd 2026
  const monDY = new RegExp(`\\b(${MONTH_RE})[a-z]*[\\s\\-/.]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,\\-/.]+(\\d{4})\\b`, 'gi');
  while ((m = monDY.exec(src))) push(isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), m[0], m.index);

  return found.sort((x, y) => x.index - y.index).map(({ iso, raw }) => ({ iso, raw }));
}

const LINE_SPLIT = /\r?\n/;
const cleanLine = (l) => l.replace(/[|•·]+/g, ' ').replace(/\s+/g, ' ').trim();

// Labels are matched at the start of a line; the value follows a separator or sits on the next line.
const LABELS = {
  beneficiaryName: [
    'beneficiary name', 'beneficiary title', 'beneficiary account title', 'to account title', 'account title',
    'receiver name', 'recipient name', 'payee name', 'receiver', 'recipient', 'beneficiary', 'payee',
    'paid to', 'sent to', 'transferred to', 'transfer to', 'credited to', 'to name', 'to',
  ],
  beneficiaryAccount: [
    'beneficiary account number', 'beneficiary account no', 'beneficiary account', 'beneficiary iban',
    'to account number', 'to account no', 'to account', 'to iban', 'receiver account', 'recipient account',
    'receiver iban', 'credit account', 'credited account', 'payee account', 'account number', 'account no',
    'a/c no', 'a/c #', 'a/c', 'iban',
  ],
  beneficiaryBank: ['beneficiary bank', 'to bank', 'receiver bank', 'recipient bank', 'bank name', 'destination bank'],
  senderName: ['sender name', 'from account title', 'remitter name', 'sender', 'remitter', 'from name', 'paid by', 'from'],
  senderAccount: ['sender account', 'from account number', 'from account', 'from iban', 'debit account', 'debited account', 'source account', 'your account'],
  transactionRef: [
    'transaction id', 'transaction reference', 'transaction ref', 'transaction no', 'transaction #', 'trx id',
    'txn id', 'tid', 'reference number', 'reference no', 'reference #', 'ref no', 'ref #', 'ref', 'rrn', 'stan',
    'transaction number', 'receipt no', 'receipt number', 'tran id', 'trans id',
  ],
  amount: ['total amount', 'transfer amount', 'amount transferred', 'amount paid', 'amount', 'total', 'sent amount'],
  date: ['transaction date', 'transfer date', 'date & time', 'date and time', 'value date', 'payment date', 'date', 'on'],
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/#&]/g, '\\$&'); }

const LABEL_RES = Object.fromEntries(Object.entries(LABELS).map(([k, list]) => [
  k, list.map((l) => new RegExp(`^${escapeRe(l).replace(/ /g, '\\s*')}\\b\\s*[:\\-–=#.]?\\s*(.*)$`, 'i')),
]));

const ALL_LABEL_RES = Object.values(LABEL_RES).flat();
const isLabelOnly = (line) => ALL_LABEL_RES.some((re) => { const m = re.exec(line); return m && !m[1].trim(); });

function labelled(lines, key) {
  for (const re of LABEL_RES[key]) {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      let value = m[1].trim();
      if (!value && i + 1 < lines.length && !isLabelOnly(lines[i + 1])) value = lines[i + 1];
      if (value) return { value, line: i };
    }
  }
  return null;
}

export function normalizeAccount(acc) {
  return String(acc || '').toUpperCase().replace(/[^A-Z0-9*X]/g, '');
}

const IBAN_RE = /\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?[0-9]){10,24}\b/i;
const ACCOUNT_RE = /(?:[*xX]{2,}[\s-]?)?\d[\d\s-]{6,24}\d/;

function extractAccount(value) {
  if (!value) return '';
  const iban = IBAN_RE.exec(value);
  if (iban) return normalizeAccount(iban[0]);
  const acc = ACCOUNT_RE.exec(value);
  if (acc) {
    const n = normalizeAccount(acc[0]);
    if (n.replace(/[^0-9]/g, '').length >= 4) return n;
  }
  const masked = /\d*[*xX]{2,}[\s-]?\d{3,6}/.exec(value);
  return masked ? normalizeAccount(masked[0]) : '';
}

function extractName(value) {
  if (!value) return '';
  // Drop account numbers / IBANs / banks glued onto the same line.
  let v = value.replace(IBAN_RE, ' ').replace(ACCOUNT_RE, ' ').replace(/[*xX]{2,}\d+/g, ' ');
  v = v.replace(/\b(?:a\/c|acc(?:ount)?|iban|no\.?|number)\b.*$/i, '');
  v = v.replace(/[^A-Za-z .&'\-()]/g, ' ').replace(/\s+/g, ' ').trim();
  return v.length >= 3 ? v : '';
}

export function parseAmount(text) {
  const src = String(text || '');
  const num = (s) => {
    const n = parseFloat(s.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lines = src.split(LINE_SPLIT).map(cleanLine).filter(Boolean);
  const hit = labelled(lines, 'amount');
  if (hit) {
    const m = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(hit.value);
    if (m && num(m[1])) return num(m[1]);
  }
  const cur = /(?:rs\.?|pkr|inr|usd|\$|aed|sar|gbp|£)\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i.exec(src);
  if (cur && num(cur[1])) return num(cur[1]);
  const after = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:rs|pkr|\/-)/i.exec(src);
  return after ? num(after[1]) : null;
}

export function detectBanks(text) {
  const src = String(text || '');
  return KNOWN_BANKS.filter((b) => new RegExp(`\\b${escapeRe(b)}\\b`, 'i').test(src));
}

/**
 * Extract structured payment details from OCR / typed receipt text.
 * Every field is a best guess; the donor confirms them and management verifies.
 */
export function parseReceipt(text) {
  const src = String(text || '');
  const lines = src.split(LINE_SPLIT).map(cleanLine).filter(Boolean);
  const dates = parseDates(src);

  const dateHit = labelled(lines, 'date');
  const labelledDates = dateHit ? parseDates(dateHit.value) : [];
  const paymentDate = (labelledDates[0] || dates[0] || {}).iso || '';

  const benNameHit = labelled(lines, 'beneficiaryName');
  const benAccHit = labelled(lines, 'beneficiaryAccount');
  const senderAccHit = labelled(lines, 'senderAccount');
  const senderNameHit = labelled(lines, 'senderName');
  const bankHit = labelled(lines, 'beneficiaryBank');
  const refHit = labelled(lines, 'transactionRef');

  let beneficiaryAccount = extractAccount(benAccHit && benAccHit.value);
  // "To: NAME 0123..." style lines carry both name and account.
  if (!beneficiaryAccount && benNameHit) beneficiaryAccount = extractAccount(benNameHit.value);
  if (!beneficiaryAccount && benNameHit && lines[benNameHit.line + 1]) beneficiaryAccount = extractAccount(lines[benNameHit.line + 1]);
  const senderAccount = extractAccount(senderAccHit && senderAccHit.value)
    || extractAccount(senderNameHit && senderNameHit.value);
  if (beneficiaryAccount && beneficiaryAccount === senderAccount) beneficiaryAccount = '';

  let transactionRef = '';
  if (refHit) {
    const m = /[A-Z0-9][A-Z0-9-]{3,}/i.exec(refHit.value.replace(/\s+/g, ''));
    if (m && /\d/.test(m[0])) transactionRef = m[0].toUpperCase();
  }

  const banks = detectBanks(src);
  let beneficiaryBank = '';
  if (bankHit) beneficiaryBank = detectBanks(bankHit.value)[0] || extractName(bankHit.value);
  if (!beneficiaryBank && benNameHit) beneficiaryBank = detectBanks(benNameHit.value)[0] || '';

  return {
    paymentDate,
    dates: dates.map((d) => d.iso),
    amount: parseAmount(src),
    beneficiaryName: extractName(benNameHit && benNameHit.value),
    beneficiaryAccount,
    beneficiaryBank,
    senderName: extractName(senderNameHit && senderNameHit.value),
    senderAccount,
    transactionRef,
    banks,
  };
}

/** True when two account strings refer to the same account (exact, IBAN suffix, or masked last digits). */
export function accountsMatch(a, b) {
  const x = normalizeAccount(a), y = normalizeAccount(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = x.replace(/[^0-9]/g, ''), dy = y.replace(/[^0-9]/g, '');
  const masked = /[*X]/.test(x) || /[*X]/.test(y);
  if (masked) {
    const tail = (s) => s.replace(/^.*[*X]/, '');
    const tx = tail(x), ty = tail(y);
    const shortTail = tx.length <= ty.length ? tx : ty;
    const other = tx.length <= ty.length ? dy : dx;
    return shortTail.length >= 3 && other.endsWith(shortTail);
  }
  const [short, long] = dx.length <= dy.length ? [dx, dy] : [dy, dx];
  return short.length >= 8 && long.endsWith(short);
}

// ---- Month helpers --------------------------------------------------------

export const monthOf = (iso) => String(iso || '').slice(0, 7);

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Week 1 = days 1-7, week 2 = 8-14, week 3 = 15-21, week 4 = 22-28, week 5 = 29-end. */
export function weekOfMonth(iso) {
  return Math.min(5, Math.ceil(Number(String(iso).slice(8, 10)) / 7));
}

export function weekRanges(month) {
  const last = daysInMonth(month);
  const out = [];
  for (let w = 1; w <= 5; w++) {
    const start = (w - 1) * 7 + 1;
    if (start > last) break;
    const end = w === 5 ? last : Math.min(w * 7, last);
    out.push({ week: w, from: `${month}-${pad(start)}`, to: `${month}-${pad(end)}` });
  }
  return out;
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
