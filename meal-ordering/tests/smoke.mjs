// 端到端验收：启动真实服务，覆盖报餐闭环、权限、重复校验、异常审核与留痕。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-test-'));
const dbFile = path.join(tmp, 'db.json');
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, MEAL_DB_FILE: dbFile, PORT: String(port) };

let passed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function cnToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const isWeekend = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

async function call(method, pathname, body, cookie) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* csv 等非 JSON */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function login(account) {
  const r = await call('POST', '/api/login', { account, password: '123456' });
  return r.cookie;
}

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const seed = spawnSync(process.execPath, ['seed.js'], { cwd: root, env, encoding: 'utf8' });
if (seed.status !== 0) {
  console.error(seed.stderr || seed.stdout);
  process.exit(1);
}

// 让"今天"处于已截止状态，便于验证逾期拦截与异常申请；未来日期仍可正常报餐。
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
db.periods.find((p) => p.id === 'L').deadlineTime = '00:01';
fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);

if (!(await waitReady())) {
  console.error('服务未能启动');
  stop();
  process.exit(1);
}

const today = cnToday();
let target = addDays(today, 1);
for (let i = 1; i <= 7; i += 1) {
  const d = addDays(today, i);
  if (!isWeekend(d)) { target = d; break; }
}

console.log('\n[1] 登录与权限');
const staff = await login('1001');
const admin = await login('9999');
const manager = await login('9001');
const leader = await login('1003');
check('职工登录成功', !!staff);
check('错误密码被拒', (await call('POST', '/api/login', { account: '1001', password: 'x' })).status === 401);
check('职工访问管理接口被拒', (await call('GET', '/api/admin/overview', null, staff)).status === 403);
check('管理员可访问看板', (await call('GET', '/api/admin/overview', null, manager)).status === 200);

console.log('\n[2] 报餐与重复校验');
const key = `k-${Date.now()}`;
const first = await call('POST', '/api/orders', { date: target, periodId: 'L', qty: 1, remark: '少辣', idempotencyKey: key }, staff);
check('未来工作日可报餐', first.json.Code === 1, JSON.stringify(first.json));
const again = await call('POST', '/api/orders', { date: target, periodId: 'L', qty: 1, idempotencyKey: key }, staff);
check('同幂等键返回同一单', again.json.Data?.order?.id === first.json.Data?.order?.id);
const [c1, c2] = await Promise.all([
  call('POST', '/api/orders', { date: target, periodId: 'B', qty: 1, idempotencyKey: `a-${Date.now()}` }, staff),
  call('POST', '/api/orders', { date: target, periodId: 'B', qty: 1, idempotencyKey: `b-${Date.now()}` }, staff),
]);
check('并发重复提交均被接受或幂等', c1.json.Code === 1 && c2.json.Code === 1);
const mine = await call('GET', `/api/orders/my?from=${target}&to=${target}`, null, staff);
check('同餐次只保留一条记录', mine.json.Data.orders.filter((o) => o.periodId === 'B').length === 1);

console.log('\n[3] 修改与取消');
const mod = await call('POST', '/api/orders', { date: target, periodId: 'L', qty: 2, remark: '加饭', idempotencyKey: `m-${Date.now()}` }, staff);
check('截止前可修改份数', mod.json.Code === 1 && mod.json.Data.order.qty === 2);
const cancel = await call('POST', '/api/orders/cancel', { orderId: first.json.Data.order.id }, staff);
check('截止前可取消', cancel.json.Code === 1 && cancel.json.Data.order.status === 2);
const revive = await call('POST', '/api/orders', { date: target, periodId: 'L', qty: 1, idempotencyKey: `r-${Date.now()}` }, staff);
check('取消后复用原单', revive.json.Data.order.id === first.json.Data.order.id && revive.json.Data.order.status === 1);

console.log('\n[4] 逾期与异常审核');
const blocked = await call('POST', '/api/orders', { date: today, periodId: 'L', qty: 1, idempotencyKey: `t-${Date.now()}` }, staff);
check('逾期或非供餐日被拦截', blocked.json.Code === 0 && ['OVERDUE', 'NOT_MEAL_DAY'].includes(blocked.json.CodeName), blocked.json.CodeName);
const apply = await call('POST', '/api/exceptions', { date: today, periodId: 'L', applyType: 1, reason: '临时加班，申请补报' }, staff);
check('可提交逾期补报申请', apply.json.Code === 1, JSON.stringify(apply.json));
const pending = await call('GET', '/api/admin/exceptions?status=1', null, manager);
const exc = pending.json.Data.exceptions.find((e) => e.id === apply.json.Data.exception.id);
check('管理员能看到待审申请', !!exc);
const audit = await call('POST', '/api/admin/exceptions/audit', { exceptionId: exc.id, approve: true, remark: '同意' }, manager);
check('审核通过后转为代报状态', audit.json.Code === 1 && audit.json.Data.exception.status === 2);

console.log('\n[5] 统计与部门范围');
const stat = await call('GET', `/api/admin/stats?date=${target}&periodId=L`, null, manager);
check('统计包含已报餐人数', stat.json.Data.total >= 1);
const leaderStat = await call('GET', `/api/admin/stats?date=${target}&periodId=L&deptId=D01`, null, leader);
check('部门负责人只能看到本部门', leaderStat.json.Data.byDept.every((d) => d.deptId === 'D03'));

console.log('\n[6] 导出与留痕');
const exp = await fetch(`${base}/api/admin/export?type=summary&date=${target}&periodId=L`, { headers: { Cookie: manager } });
const text = await exp.text();
check('汇总导出返回 CSV', exp.ok && text.includes('部门') && text.includes('合计'));
check('导出被拒绝于普通职工', (await fetch(`${base}/api/admin/export?type=summary&date=${target}&periodId=L`, { headers: { Cookie: staff } })).status === 403);
const logs = await call('GET', '/api/admin/logs?limit=100', null, admin);
check('操作留痕已记录', logs.json.Data.logs.length > 0 && logs.json.Data.logs.some((l) => l.action === '导出数据'));

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
stop();
process.exit(failures.length ? 1 : 0);
