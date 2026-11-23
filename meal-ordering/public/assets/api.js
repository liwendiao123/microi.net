export async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { data = { Code: 0, Msg: '服务返回异常' }; }
  if (data.Code !== 1) {
    const err = new Error(data.Msg || '请求失败');
    err.code = data.CodeName;
    err.status = res.status;
    throw err;
  }
  return data.Data;
}

export function toast(message, ms = 2200) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.remove('show'), ms);
}

export const STATUS_TEXT = { 1: '已报餐', 2: '已取消', 3: '逾期待审', 4: '管理员代报', 5: '已锁定' };

export function statusTag(status) {
  const cls = { 1: 'ok', 2: 'gray', 3: 'warn', 4: 'ok', 5: 'gray' }[status] || '';
  return `<span class="tag ${cls}">${STATUS_TEXT[status] || '—'}</span>`;
}

export function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayName(date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
