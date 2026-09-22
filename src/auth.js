import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, fail } from './http.js';

const COOKIE = 'bua_session';
const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function loadSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function createAuth(db, secret, { secureCookies = false } = {}) {
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function issue(res, user) {
    const payload = Buffer.from(JSON.stringify({
      uid: user.id, v: user.session_version, exp: Date.now() + SESSION_DAYS * 864e5,
    })).toString('base64url');
    const token = `${payload}.${sign(payload)}`;
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureCookies ? '; Secure' : ''}`);
  }

  function clear(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (!data.exp || data.exp < Date.now()) return null;
    const user = db.prepare('SELECT id, role, name, email, phone, city, session_version, active FROM users WHERE id = ?').get(data.uid);
    if (!user || !user.active || user.session_version !== data.v) return null;
    return user;
  }

  const requireUser = (ctx) => { if (!ctx.user) fail(401, 'Please sign in'); };
  const requireAdmin = (ctx) => {
    requireUser(ctx);
    if (ctx.user.role !== 'admin') fail(403, 'Management access only');
  };
  const requireDonor = (ctx) => {
    requireUser(ctx);
    if (ctx.user.role !== 'donor') fail(403, 'Donor access only');
  };

  return { issue, clear, currentUser, requireUser, requireAdmin, requireDonor };
}

// Simple in-memory brute-force guard for the login endpoint.
const attempts = new Map();
export function checkLoginRate(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  rec.count++;
  attempts.set(key, rec);
  if (rec.count > 10) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}
export const resetLoginRate = (key) => attempts.delete(key);
