// 登录、会话与密码校验。
// 会话写入 db.sessions，服务重启后仍然有效；Cookie 为 HttpOnly + SameSite=Lax。

import crypto from 'node:crypto';
import { getDb, save } from './store.js';
import { checkPassword } from './password.js';

const COOKIE = 'meal_session';
const MAX_AGE = 7 * 24 * 3600;

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function login(account, password) {
  const db = getDb();
  const user = db.users.find((u) => u.account === String(account || '').trim());
  if (!user || user.active === false) return null;
  if (!checkPassword(password, user)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, created: Date.now() };
  save();
  return { token, user };
}

export function logout(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return;
  const db = getDb();
  delete db.sessions[token];
  save();
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const db = getDb();
  const s = db.sessions[token];
  if (!s) return null;
  const user = db.users.find((u) => u.id === s.userId && u.active !== false);
  return user ? { ...user, token } : null;
}

export function publicUser(user) {
  if (!user) return null;
  const { pwdHash, salt, token, ...rest } = user;
  return rest;
}
