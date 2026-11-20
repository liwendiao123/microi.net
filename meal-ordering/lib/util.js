// 时间、日期与 CSV 工具。
// 业务口径固定为 Asia/Shanghai：所有截止判断都走这里，避免客户端改时间绕过。

const pad = (n) => String(n).padStart(2, '0');

export function cnNow(raw = new Date()) {
  // 用 UTC 读取"东八区墙上时间"，不依赖宿主机时区。
  const s = new Date(raw.getTime() + 8 * 3600 * 1000);
  return {
    date: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
    time: `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`,
    stamp: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}`,
  };
}

export function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

export function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

// 截止时间戳：date 当天的 time，dayOffset=-1 表示前一天截止（如早餐）。
export function deadlineTs(dateStr, time, dayOffset = 0) {
  return new Date(`${dateStr}T${time}:00+08:00`).getTime() + dayOffset * 86400000;
}

export function minutesLeft(ts, now = Date.now()) {
  return Math.round((ts - now) / 60000);
}

export function csv(rows, headers) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = headers.map((h) => esc(h.label)).join(',');
  const body = rows.map((r) => headers.map((h) => esc(r[h.key])).join(',')).join('\n');
  return `\uFEFF${head}\n${body}`;
}
