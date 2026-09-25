// Donor login rules set by the foundation:
//   username = Pakistani mobile in local form (03xxxxxxxxx); for numbers outside Pakistan (or no
//              number) the donor's first name, made unique with a number (rizwana, rizwana2, …)
//   password = "bua-" + the donor's orphan code, e.g. bua-or001 (their lowest code if several)
import { hashPassword } from './auth.js';

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'hazrat', 'sheikh', 'syed', 'haji', 'hafiz', 'mian']);

/** "+923001234567" -> "03001234567"; anything that isn't a Pakistani mobile -> null. */
export function localPkMobile(phone) {
  const m = /^\+92(3\d{9})$/.exec(String(phone || ''));
  return m ? `0${m[1]}` : null;
}

export function firstNameBase(name) {
  const words = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  const i = words.findIndex((w) => !TITLES.has(w) && /[a-z]/.test(w));
  if (i < 0) return 'donor';
  // Short particles like "al" or "el" read better joined to the next word ("alghurba").
  return words[i].length < 3 && words[i + 1] ? words[i] + words[i + 1] : words[i].padEnd(3, '1');
}

function usernameTaken(db, username, excludeId) {
  return !!db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(username, excludeId ?? -1);
}

/** The username the rules give this donor, unique across all accounts. */
export function makeUsername(db, user) {
  const mobile = localPkMobile(user.phone);
  if (mobile && !usernameTaken(db, mobile, user.id)) return mobile;
  const base = firstNameBase(user.name);
  let candidate = base;
  for (let n = 2; usernameTaken(db, candidate, user.id); n++) candidate = `${base}${n}`;
  return candidate;
}

export function defaultPassword(db, userId) {
  const row = db.prepare(`SELECT o.orphan_no FROM donor_orphans d JOIN orphans o ON o.id = d.orphan_id
    WHERE d.donor_id = ? ORDER BY o.orphan_no LIMIT 1`).get(userId);
  const code = row ? row.orphan_no : `donor${userId}`;
  return `bua-${code.toLowerCase().replace(/\s+/g, '')}`;
}

export function validUsername(u) {
  return /^[a-z0-9._-]{3,40}$/i.test(u);
}

/**
 * Give a donor their login. Without overrides it follows the rules above; the password is stored
 * so management can hand it over, until the donor changes it.
 */
export function issueLogin(db, userId, { username, password } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const uname = username || makeUsername(db, user);
  const pw = password || defaultPassword(db, userId);
  db.prepare(`UPDATE users SET username = ?, password_hash = ?, default_password = ?, password_is_default = 1,
    session_version = session_version + 1 WHERE id = ?`).run(uname, hashPassword(pw), pw, userId);
  return { username: uname, password: pw };
}
