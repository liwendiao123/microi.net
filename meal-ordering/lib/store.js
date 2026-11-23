// 极简 JSON 数据层：原子写 + 首次启动自动生成演示数据。
// 数据目录优先使用项目内 data/；不可写时回落到 TMPDIR，适配只读的部署环境。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSeed } from './seed-data.js';

function pickDataDir() {
  if (process.env.MEAL_DB_FILE) return path.dirname(process.env.MEAL_DB_FILE);
  if (process.env.MEAL_DATA_DIR) return process.env.MEAL_DATA_DIR;
  const candidates = [
    path.join(process.cwd(), 'data'),
    path.join(process.env.TMPDIR || os.tmpdir(), 'meal-ordering-data'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try next */ }
  }
  return os.tmpdir();
}

const dbFile = process.env.MEAL_DB_FILE || path.join(pickDataDir(), 'db.json');

let cache = null;

export function dbFileExists() {
  return fs.existsSync(dbFile);
}

export function getDb() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch {
      cache = buildSeed();
      save();
    }
  }
  return cache;
}

export function save() {
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const tmp = `${dbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, dbFile);
  } catch (err) {
    // 只读环境下降级为内存态，保证服务可用。
    console.warn('[store] 数据文件写入失败，当前仅内存生效:', err.message);
  }
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
