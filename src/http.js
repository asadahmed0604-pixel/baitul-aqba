// Minimal HTTP toolkit on top of node:http: routing, body parsing, cookies, static files.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const fail = (status, message, details) => { throw new HttpError(status, message, details); };

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

export function sendFile(res, content, { type, filename, inline = false }) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (filename) headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`;
  res.writeHead(200, headers);
  res.end(content);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ } }
  }
  return out;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c); // keep draining past the limit so we can still reply
    });
    req.on('end', () => {
      if (size > limit) reject(new HttpError(413, `Upload too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Parse multipart/form-data into { fields, files }. Files are { filename, contentType, data }. */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new HttpError(400, 'Missing multipart boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {}, files = {};
  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start + 2, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const body = buffer.slice(headerEnd + 4, next - 2); // strip trailing CRLF
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (name != null) {
      if (filename != null) {
        if (body.length) files[name] = { filename, contentType: ctype || 'application/octet-stream', data: body };
      } else {
        fields[name] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function serveStatic(root, req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html'; // /donor -> donor.html
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---- Image inspection ----------------------------------------------------

/** Detect image type and pixel dimensions from the file header (PNG, JPEG, WebP). */
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { type: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { type: 'webp', mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'webp', mime: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return { type: 'webp', mime: 'image/webp', width: 0, height: 0 };
  }
  return null;
}
