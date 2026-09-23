// RFC 4180 CSV helpers. Output carries a UTF-8 BOM so Excel opens it with correct encoding.

export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection from user-supplied text.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Keep each record's position so import errors can name the spreadsheet row.
  const nonEmpty = rows.map((r, i) => ({ r, rowNo: i + 1 })).filter(({ r }) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].r.map(normalizeHeader);
  return nonEmpty.slice(1).map(({ r, rowNo }) => {
    const obj = Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '')]));
    Object.defineProperty(obj, '_row', { value: rowNo });
    return obj;
  });
}

export const normalizeHeader = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
