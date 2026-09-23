// Minimal .xlsx reader (first worksheet only) using just node:zlib. Returns the same shape as
// parseCsv: an array of row objects keyed by normalised header, each with a non-enumerable
// `_row` holding the spreadsheet row number.
import zlib from 'node:zlib';
import { fail } from './http.js';
import { normalizeHeader } from './csv.js';

function unzip(buf) {
  // Locate the End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail(400, 'This file is not a valid Excel (.xlsx) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, e) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'amp') return '&';
  return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function isXlsx(buf) {
  return buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function parseXlsx(buf) {
  const files = unzip(buf);
  const strings = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  // First sheet in workbook order.
  const wb = files['xl/workbook.xml']?.() || '';
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const rels = files['xl/_rels/workbook.xml.rels']?.() || '';
  let target = firstRid && new RegExp(`<Relationship\\b[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  if (!target && firstRid) target = new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(rels)?.[1];
  target = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  if (!files[target]) fail(400, 'Could not find a worksheet in this Excel file');
  const sheet = files[target]();

  const grid = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(/\br="(\d+)"/.exec(rm[1])?.[1]);
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (v != null) value = decode(v);
      if (ref) cells[colIndex(ref)] = value;
    }
    grid.push({ rowNo, cells });
  }
  const nonEmpty = grid.filter((r) => r.cells.some((v) => String(v ?? '').trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = Array.from(nonEmpty[0].cells, (h) => normalizeHeader(h ?? ''));
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { if (h) obj[h] = String(r.cells[i] ?? '').trim(); });
    Object.defineProperty(obj, '_row', { value: r.rowNo });
    return obj;
  });
}
