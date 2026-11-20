// 报餐系统 HTTP 服务：静态页面 + JSON 接口，零第三方依赖。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, save } from './lib/store.js';
import { login, logout, currentUser, publicUser, sessionCookie, clearCookie } from './lib/auth.js';
import {
  AppError, ST, ST_TEXT, isMealDay, ruleFor, periodById, menuFor, deadlineInfo,
  submitOrder, cancelOrder, createException, auditException, statsByDept, overview, orderView, writeLog,
} from './lib/domain.js';
import { cnNow, isDateStr, addDays, csv, minutesLeft } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);

const routes = [];
const route = (method, pathname, handler) => routes.push({ method, pathname, handler });

/* ------------------------------ helpers ------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function ok(res, data = {}, msg = '') {
  sendJson(res, 200, { Code: 1, Data: data, Msg: msg });
}

function fail(res, err) {
  const status = err.status || 500;
  sendJson(res, status, { Code: 0, CodeName: err.code || 'ERROR', Msg: err.message || '服务异常' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new AppError('请求体过大', 'PAYLOAD_TOO_LARGE', 413));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new AppError('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function ctxOf(req) {
  return { ip: req.socket.remoteAddress || '', source: 'web' };
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new AppError('登录已失效，请重新登录', 'UNAUTHORIZED', 401);
  return user;
}

function requireRole(req, roles) {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw new AppError('无权访问该功能', 'FORBIDDEN', 403);
  return user;
}

const isManager = (u) => u.role === 'manager' || u.role === 'admin';

function timeState(date, period) {
  const dl = deadlineInfo(date, period);
  const left = minutesLeft(dl.ts);
  return {
    deadlineText: `${date} ${dl.text}`,
    passed: dl.passed,
    minutesLeft: left,
    countdown: left > 0 ? `${Math.floor(left / 60)} 小时 ${left % 60} 分` : '已截止',
  };
}

function myOrder(db, userId, date, periodId) {
  return db.orders.find((o) => o.userId === userId && o.date === date && o.periodId === periodId) || null;
}

/* ------------------------------- auth -------------------------------- */

route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const result = login(body.account, body.password);
  if (!result) throw new AppError('工号或密码不正确', 'LOGIN_FAILED', 401);
  res.setHeader('Set-Cookie', sessionCookie(result.token));
  ok(res, { user: publicUser(result.user) });
});

route('POST', '/api/logout', async (req, res) => {
  logout(req);
  res.setHeader('Set-Cookie', clearCookie());
  ok(res);
});

route('GET', '/api/me', async (req, res) => {
  const user = currentUser(req);
  ok(res, { user: publicUser(user), permissions: user ? { manager: isManager(user), admin: user.role === 'admin' } : null });
});

/* ------------------------------- staff ------------------------------- */

route('GET', '/api/home', async (req, res, url) => {
  const user = requireUser(req);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  if (!isDateStr(date)) throw new AppError('日期格式不正确');
  const rule = ruleFor(db, user.deptId);
  const periods = db.periods
    .filter((p) => p.status === 1)
    .sort((a, b) => a.sort - b.sort)
    .map((p) => {
      const menu = menuFor(db, date, p.id);
      const order = myOrder(db, user.id, date, p.id);
      return {
        id: p.id,
        name: p.periodName,
        serve: `${p.serveStart}-${p.serveEnd}`,
        ...timeState(date, p),
        menu: menu ? { id: menu.id, title: menu.title, status: menu.status, items: menu.items } : null,
        order: order ? orderView(db, order) : null,
        canOrder: isMealDay(db, date) && menu?.status === 2 && !deadlineInfo(date, p).passed,
      };
    });
  ok(res, { date, isMealDay: isMealDay(db, date), calendar: db.calendar?.[date] || null, rule, periods });
});

route('GET', '/api/menu', async (req, res, url) => {
  const user = requireUser(req);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  const periodId = url.searchParams.get('periodId');
  const period = periodById(db, periodId);
  if (!period) throw new AppError('餐次不存在', 'NOT_FOUND', 404);
  const menu = menuFor(db, date, periodId);
  ok(res, {
    date,
    period: { ...period, ...timeState(date, period) },
    menu: menu || null,
    isMealDay: isMealDay(db, date),
    order: orderView(db, myOrder(db, user.id, date, periodId)),
  });
});

route('POST', '/api/orders', async (req, res) => {
  const user = requireUser(req);
  const body = await readBody(req);
  const result = submitOrder(user, body, ctxOf(req));
  ok(res, { order: orderView(getDb(), result.order), mode: result.mode }, result.mode === 'created' ? '报餐成功' : '已更新报餐');
});

route('POST', '/api/orders/cancel', async (req, res) => {
  const user = requireUser(req);
  const body = await readBody(req);
  const order = cancelOrder(user, body.orderId, ctxOf(req), isManager(user));
  ok(res, { order: orderView(getDb(), order) }, '已取消报餐');
});

route('GET', '/api/orders/my', async (req, res, url) => {
  const user = requireUser(req);
  const db = getDb();
  const to = url.searchParams.get('to') || addDays(cnNow().date, 7);
  const from = url.searchParams.get('from') || addDays(cnNow().date, -30);
  const rows = db.orders
    .filter((o) => o.userId === user.id && o.date >= from && o.date <= to)
    .sort((a, b) => (a.date === b.date ? a.periodId.localeCompare(b.periodId) : b.date.localeCompare(a.date)))
    .map((o) => orderView(db, o));
  ok(res, { from, to, orders: rows });
});

route('POST', '/api/exceptions', async (req, res) => {
  const user = requireUser(req);
  const body = await readBody(req);
  const ex = createException(user, body, ctxOf(req));
  ok(res, { exception: ex }, '申请已提交，等待管理员审核');
});

route('GET', '/api/exceptions/my', async (req, res) => {
  const user = requireUser(req);
  const db = getDb();
  ok(res, { exceptions: db.exceptions.filter((e) => e.userId === user.id).slice(0, 50) });
});

/* ------------------------------- admin ------------------------------- */

route('GET', '/api/admin/overview', async (req, res, url) => {
  const user = requireRole(req, ['leader', 'manager', 'admin']);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  const data = overview(db, date);
  if (user.role === 'leader') {
    data.byPeriod = data.byPeriod.map((p) => {
      const s = statsByDept(db, { date, periodId: p.periodId, deptId: user.deptId });
      return { ...p, total: s.total, qty: s.qty, scoped: true };
    });
    data.total = data.byPeriod.reduce((s, x) => s + x.total, 0);
  }
  ok(res, data);
});

route('GET', '/api/admin/stats', async (req, res, url) => {
  const user = requireRole(req, ['leader', 'manager', 'admin']);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  const periodId = url.searchParams.get('periodId') || 'L';
  if (!periodById(db, periodId)) throw new AppError('餐次不存在');
  const deptId = user.role === 'leader' ? user.deptId : (url.searchParams.get('deptId') || null);
  ok(res, { date, periodId, ...statsByDept(db, { date, periodId, deptId }) });
});

route('GET', '/api/admin/orders', async (req, res, url) => {
  const user = requireRole(req, ['leader', 'manager', 'admin']);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  const periodId = url.searchParams.get('periodId') || '';
  const status = Number(url.searchParams.get('status') || 0);
  const deptId = user.role === 'leader' ? user.deptId : (url.searchParams.get('deptId') || '');
  const rows = db.orders
    .filter((o) => o.date === date && (!periodId || o.periodId === periodId) && (!status || o.status === status) && (!deptId || o.deptId === deptId))
    .map((o) => orderView(db, o));
  ok(res, { date, orders: rows });
});

route('GET', '/api/admin/exceptions', async (req, res, url) => {
  requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const status = Number(url.searchParams.get('status') || 0);
  const rows = db.exceptions.filter((e) => !status || e.status === status).slice(0, 200);
  ok(res, { exceptions: rows });
});

route('POST', '/api/admin/exceptions/audit', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const body = await readBody(req);
  const ex = auditException(user, body, ctxOf(req));
  ok(res, { exception: ex }, body.approve ? '已通过' : '已驳回');
});

route('POST', '/api/admin/proxy', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const body = await readBody(req);
  const target = db.users.find((u) => u.id === body.userId);
  if (!target) throw new AppError('报餐人不存在', 'NOT_FOUND', 404);
  const result = submitOrder({ ...target }, { ...body, proxy: true }, { ...ctxOf(req), operator: user, source: 'admin' });
  ok(res, { order: orderView(db, result.order) }, '代报成功');
});

route('POST', '/api/admin/orders/cancel', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const body = await readBody(req);
  const order = cancelOrder(user, body.orderId, ctxOf(req), true);
  ok(res, { order: orderView(getDb(), order) }, '已取消该报餐');
});

route('GET', '/api/admin/export', async (req, res, url) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const type = url.searchParams.get('type') || 'summary';
  const date = url.searchParams.get('date') || cnNow().date;
  const periodId = url.searchParams.get('periodId') || 'L';
  const period = periodById(db, periodId);
  if (!period) throw new AppError('餐次不存在');
  let content = '';
  let filename = '';
  if (type === 'detail') {
    const rows = db.orders
      .filter((o) => o.date === date && o.periodId === periodId)
      .map((o) => ({
        date: o.date, period: period.periodName, dept: o.deptName, name: o.userName,
        status: ST_TEXT[o.status], qty: o.qty, submitTime: o.submitTime, remark: o.remark,
      }));
    content = csv(rows, [
      { key: 'date', label: '日期' }, { key: 'period', label: '餐次' }, { key: 'dept', label: '部门' },
      { key: 'name', label: '姓名' }, { key: 'status', label: '状态' }, { key: 'qty', label: '份数' },
      { key: 'submitTime', label: '提交时间' }, { key: 'remark', label: '备注' },
    ]);
    filename = `meal-detail-${date}-${periodId}.csv`;
  } else {
    const s = statsByDept(db, { date, periodId });
    const rows = s.byDept.map((d) => ({ dept: d.deptName, count: d.count, qty: d.qty }));
    rows.push({ dept: '合计', count: s.total, qty: s.qty });
    content = csv(rows, [
      { key: 'dept', label: '部门' }, { key: 'count', label: '报餐人数' }, { key: 'qty', label: '份数' },
    ]);
    filename = `meal-summary-${date}-${periodId}.csv`;
  }
  writeLog(db, { action: '导出数据', after: { type, date, periodId }, operator: user, ip: req.socket.remoteAddress, source: 'admin' });
  save();
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(content);
});

route('GET', '/api/admin/menus', async (req, res, url) => {
  requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const date = url.searchParams.get('date') || cnNow().date;
  const menus = db.menus.filter((m) => m.date === date);
  const periods = db.periods.filter((p) => p.status === 1).sort((a, b) => a.sort - b.sort);
  ok(res, { date, periods, menus });
});

route('POST', '/api/admin/menus/save', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const body = await readBody(req);
  if (!isDateStr(body.date)) throw new AppError('日期格式不正确');
  const period = periodById(db, body.periodId);
  if (!period) throw new AppError('餐次不存在');
  let menu = menuFor(db, body.date, body.periodId);
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i) => String(i.name || '').trim())
    .map((i, idx) => ({
      id: i.id || `dish_${idx}`,
      name: String(i.name).trim().slice(0, 60),
      type: String(i.type || '热菜'),
      price: Number(i.price || 0),
      isMain: !!i.isMain,
      sort: idx + 1,
    }));
  if (!menu) {
    menu = {
      id: `menu_${body.date}_${body.periodId}`,
      date: body.date,
      periodId: body.periodId,
      title: '',
      status: 1,
      publishTime: null,
      publishUserId: null,
      remark: '',
      items: [],
    };
    db.menus.push(menu);
  }
  const before = JSON.parse(JSON.stringify(menu));
  menu.title = String(body.title || '').trim().slice(0, 100) || `${body.date} ${period.periodName}`;
  menu.items = items;
  menu.remark = String(body.remark || '').slice(0, 300);
  writeLog(db, { action: '保存菜单', before, after: menu, operator: user, ip: req.socket.remoteAddress, source: 'admin' });
  save();
  ok(res, { menu }, '菜单已保存');
});

route('POST', '/api/admin/menus/publish', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const body = await readBody(req);
  const menu = menuFor(db, body.date, body.periodId);
  if (!menu) throw new AppError('请先保存菜单', 'NOT_FOUND', 404);
  const before = JSON.parse(JSON.stringify(menu));
  menu.status = Number(body.status) === 3 ? 3 : 2;
  menu.publishTime = menu.status === 2 ? cnNow().stamp : menu.publishTime;
  menu.publishUserId = menu.status === 2 ? user.id : menu.publishUserId;
  writeLog(db, { action: menu.status === 2 ? '发布菜单' : '停用菜单', before, after: menu, operator: user, ip: req.socket.remoteAddress, source: 'admin' });
  save();
  ok(res, { menu }, menu.status === 2 ? '菜单已发布' : '菜单已停用');
});

route('GET', '/api/admin/rules', async (req, res) => {
  requireRole(req, ['manager', 'admin']);
  const db = getDb();
  ok(res, { rules: db.rules, periods: db.periods, depts: db.depts });
});

route('POST', '/api/admin/rules/save', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const body = await readBody(req);
  const scopeType = Number(body.scopeType || 1);
  const deptId = scopeType === 2 ? body.deptId : null;
  if (scopeType === 2 && !db.depts.some((d) => d.id === deptId)) throw new AppError('部门不存在');
  let rule = db.rules.find((r) => r.scopeType === scopeType && r.deptId === deptId);
  const before = rule ? JSON.parse(JSON.stringify(rule)) : null;
  if (!rule) {
    rule = { id: `rule_${scopeType}_${deptId || 'all'}`, scopeType, deptId };
    db.rules.push(rule);
  }
  Object.assign(rule, {
    advanceDays: Math.max(0, Number(body.advanceDays ?? 7)),
    allowModify: body.allowModify ? 1 : 0,
    allowCancel: body.allowCancel ? 1 : 0,
    overduePolicy: Number(body.overduePolicy ?? 1),
    maxQtyPerMeal: Math.max(1, Number(body.maxQtyPerMeal ?? 1)),
    remindEnabled: body.remindEnabled ? 1 : 0,
  });
  writeLog(db, { action: '保存报餐规则', before, after: rule, operator: user, ip: req.socket.remoteAddress, source: 'admin' });
  save();
  ok(res, { rule }, '规则已保存');
});

route('GET', '/api/admin/calendar', async (req, res, url) => {
  requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const month = url.searchParams.get('month') || cnNow().date.slice(0, 7);
  const rows = Object.entries(db.calendar || {})
    .filter(([d]) => d.startsWith(month))
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  ok(res, { month, calendar: rows });
});

route('POST', '/api/admin/calendar/save', async (req, res) => {
  const user = requireRole(req, ['manager', 'admin']);
  const db = getDb();
  const body = await readBody(req);
  if (!isDateStr(body.date)) throw new AppError('日期格式不正确');
  const before = db.calendar[body.date] || null;
  db.calendar[body.date] = {
    dayType: Number(body.dayType || 1),
    isMealDay: body.isMealDay ? 1 : 0,
    remark: String(body.remark || '').slice(0, 100),
  };
  writeLog(db, { action: '调整工作日历', before, after: { date: body.date, ...db.calendar[body.date] }, operator: user, ip: req.socket.remoteAddress, source: 'admin' });
  save();
  ok(res, { calendar: db.calendar[body.date] }, '已保存');
});

route('GET', '/api/admin/logs', async (req, res, url) => {
  requireRole(req, ['admin']);
  const db = getDb();
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
  ok(res, { logs: db.logs.slice(0, limit) });
});

route('GET', '/api/admin/users', async (req, res) => {
  requireRole(req, ['manager', 'admin']);
  const db = getDb();
  ok(res, { users: db.users.map((u) => ({ id: u.id, account: u.account, name: u.name, deptId: u.deptId, deptName: u.deptName, role: u.role })) });
});

route('GET', '/api/health', async (req, res) => ok(res, { status: 'ok', time: cnNow().stamp }));

/* ------------------------------ static ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PAGES = { '/': 'index.html', '/login': 'login.html', '/app': 'app.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------ server ------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    const hit = routes.find((r) => r.method === req.method && r.pathname === pathname);
    if (hit) { await hit.handler(req, res, url); return; }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) { serveStatic(req, res, pathname); return; }
    throw new AppError('接口不存在', 'NOT_FOUND', 404);
  } catch (err) {
    if (err instanceof AppError) { fail(res, err); return; }
    console.error(err);
    fail(res, new AppError('服务异常，请稍后重试', 'INTERNAL', 500));
  }
});

server.listen(PORT, () => {
  console.log(`报餐系统已启动: http://localhost:${PORT}`);
  console.log(`职工端: /app    管理端: /admin    登录: /login`);
});
