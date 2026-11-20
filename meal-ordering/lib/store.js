// 极简 JSON 数据层：单文件持久化 + 原子写。
// MVP 单进程足够；Node 单线程天然串行，写前不额外加锁。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.join(process.cwd(), 'data');
const dbFile = process.env.MEAL_DB_FILE || path.join(dataDir, 'db.json');

let cache = null;

export function dbFileExists() {
  return fs.existsSync(dbFile);
}

export function getDb() {
  if (!cache) cache = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  return cache;
}

export function save() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, dbFile);
}

export function replaceDb(next) {
  cache = next;
  save();
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export function snapshot(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}
