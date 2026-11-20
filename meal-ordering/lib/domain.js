// 业务规则：供餐日、截止时间、报餐、取消、异常申请与统计。
// 所有写操作都在这里收敛，接口层只负责鉴权与参数透传。

import { getDb, save, newId, snapshot } from './store.js';
import { cnNow, isDateStr, weekday, daysBetween, deadlineTs } from './util.js';

export const ST = { BOOKED: 1, CANCELLED: 2, PENDING: 3, PROXY: 4, LOCKED: 5 };
export const ST_TEXT = { 1: '已报餐', 2: '已取消', 3: '逾期待审', 4: '管理员代报', 5: '已锁定' };

export class AppError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isMealDay(db, date) {
  const row = db.calendar?.[date];
  if (row) return !!row.isMealDay;
  const w = weekday(date);
  return w !== 0 && w !== 6;
}

export function ruleFor(db, deptId) {
  return (
    db.rules.find((r) => r.scopeType === 2 && r.deptId === deptId) ||
    db.rules.find((r) => r.scopeType === 1)
  );
}

export function periodById(db, id) {
  return db.periods.find((p) => p.id === id);
}

export function menuFor(db, date, periodId) {
  return db.menus.find((m) => m.date === date && m.periodId === periodId);
}

export function deadlineInfo(date, period) {
  if (!period) return { ts: 0, passed: true, text: '--' };
  const ts = deadlineTs(date, period.deadlineTime, period.deadlineDayOffset || 0);
  return { ts, passed: Date.now() > ts, text: period.deadlineTime };
}

export function writeLog(db, { orderId = null, exceptionId = null, action, before = null, after = null, operator, ip = '', source = 'web' }) {
  db.logs.unshift({
    id: newId('log'),
    orderId,
    exceptionId,
    action,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    operatorId: operator.id,
    operatorName: operator.name,
    operatorRole: operator.role,
    clientIp: ip,
    source,
    createTime: cnNow().stamp,
  });
  if (db.logs.length > 5000) db.logs.length = 5000;
}

export function orderView(db, order) {
  const period = periodById(db, order.periodId);
  return { ...order, periodName: period?.periodName || order.periodId, statusText: ST_TEXT[order.status] || '' };
}

export function submitOrder(user, input, ctx = {}) {
  const db = getDb();
  const date = input.date;
  const periodId = input.periodId;
  if (!isDateStr(date)) throw new AppError('日期格式不正确');
  const period = periodById(db, periodId);
  if (!period || period.status !== 1) throw new AppError('餐次不存在或已停用');
  const rule = ruleFor(db, user.deptId);
  if (!rule) throw new AppError('未配置报餐规则，请联系管理员', 'NO_RULE', 409);

  const qty = Number(input.qty ?? 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > rule.maxQtyPerMeal) {
    throw new AppError(`份数需为 1-${rule.maxQtyPerMeal} 的整数`);
  }

  const today = cnNow().date;
  if (date < today) throw new AppError('不能补报过去的日期');
  if (daysBetween(today, date) > rule.advanceDays) throw new AppError(`最多提前 ${rule.advanceDays} 天报餐`);
  if (!isMealDay(db, date)) throw new AppError('该日期不供餐');
  const menu = menuFor(db, date, periodId);
  if (!menu || menu.status !== 2) throw new AppError('该餐次菜单尚未发布', 'NO_MENU', 409);

  const proxy = !!input.proxy;
  if (!proxy && deadlineInfo(date, period).passed) {
    throw new AppError('已过报餐截止时间，请提交逾期申请', 'OVERDUE', 409);
  }

  const existing = db.orders.find((o) => o.userId === user.id && o.date === date && o.periodId === periodId);
  if (existing && existing.status === ST.LOCKED) throw new AppError('该报餐已锁定，无法修改', 'LOCKED', 409);
  if (existing && !proxy && input.idempotencyKey && existing.idempotencyKey === input.idempotencyKey && existing.status !== ST.CANCELLED) {
    return { order: existing, mode: 'idempotent' };
  }

  const now = cnNow();
  if (existing) {
    const before = snapshot(existing);
    existing.qty = qty;
    existing.remark = String(input.remark ?? '').slice(0, 300);
    existing.status = proxy ? ST.PROXY : ST.BOOKED;
    existing.source = proxy ? 2 : 1;
    existing.idempotencyKey = input.idempotencyKey || '';
    existing.submitTime = now.stamp;
    existing.cancelTime = null;
    writeLog(db, {
      orderId: existing.id,
      action: before.status === ST.CANCELLED ? '重新报餐' : '修改报餐',
      before,
      after: snapshot(existing),
      operator: ctx.operator || user,
      ip: ctx.ip,
      source: ctx.source,
    });
    save();
    return { order: existing, mode: 'updated' };
  }

  const order = {
    id: newId('ord'),
    userId: user.id,
    userName: user.name,
    deptId: user.deptId,
    deptName: user.deptName,
    date,
    periodId,
    status: proxy ? ST.PROXY : ST.BOOKED,
    source: proxy ? 2 : 1,
    qty,
    remark: String(input.remark ?? '').slice(0, 300),
    submitTime: now.stamp,
    cancelTime: null,
    lockTime: null,
    idempotencyKey: input.idempotencyKey || '',
  };
  db.orders.push(order);
  writeLog(db, { orderId: order.id, action: proxy ? '管理员代报' : '提交报餐', after: snapshot(order), operator: ctx.operator || user, ip: ctx.ip, source: ctx.source });
  save();
  return { order, mode: 'created' };
}

export function cancelOrder(user, orderId, ctx = {}, asManager = false) {
  const db = getDb();
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new AppError('报餐记录不存在', 'NOT_FOUND', 404);
  if (order.userId !== user.id && !asManager) throw new AppError('无权操作他人报餐', 'FORBIDDEN', 403);
  if (order.status === ST.LOCKED) throw new AppError('该报餐已锁定，无法取消', 'LOCKED', 409);
  if (order.status === ST.CANCELLED) return order;

  const rule = ruleFor(db, order.deptId);
  const period = periodById(db, order.periodId);
  if (!asManager) {
    if (!rule?.allowCancel) throw new AppError('当前规则不允许取消报餐', 'CANCEL_DENIED', 409);
    if (deadlineInfo(order.date, period).passed) throw new AppError('已过截止时间，请提交逾期撤销申请', 'OVERDUE', 409);
  }

  const before = snapshot(order);
  order.status = ST.CANCELLED;
  order.cancelTime = cnNow().stamp;
  writeLog(db, { orderId: order.id, action: asManager ? '管理员取消' : '取消报餐', before, after: snapshot(order), operator: user, ip: ctx.ip, source: ctx.source });
  save();
  return order;
}

export function createException(user, input, ctx = {}) {
  const db = getDb();
  const date = input.date;
  const periodId = input.periodId;
  const applyType = Number(input.applyType || 1);
  const reason = String(input.reason || '').trim();
  if (!isDateStr(date)) throw new AppError('日期格式不正确');
  const period = periodById(db, periodId);
  if (!period) throw new AppError('餐次不存在');
  if (reason.length < 2) throw new AppError('请填写申请原因');
  if (!deadlineInfo(date, period).passed) throw new AppError('尚未截止，可直接自助修改或取消', 'NOT_OVERDUE', 409);
  if (![1, 2, 3].includes(applyType)) throw new AppError('申请类型不正确');

  let order = db.orders.find((o) => o.userId === user.id && o.date === date && o.periodId === periodId);
  if (order?.status === ST.PENDING) throw new AppError('该餐次已有待审核申请', 'DUPLICATE', 409);
  if (order?.status === ST.LOCKED) throw new AppError('该报餐已锁定，无法申请', 'LOCKED', 409);

  const now = cnNow();
  if (!order) {
    if (applyType !== 1) throw new AppError('没有可操作的报餐记录');
    order = {
      id: newId('ord'),
      userId: user.id,
      userName: user.name,
      deptId: user.deptId,
      deptName: user.deptName,
      date,
      periodId,
      status: ST.PENDING,
      source: 3,
      qty: 1,
      remark: '',
      submitTime: now.stamp,
      cancelTime: null,
      lockTime: null,
      idempotencyKey: '',
    };
    db.orders.push(order);
  } else {
    order.status = ST.PENDING;
  }

  const ex = {
    id: newId('exc'),
    orderId: order.id,
    userId: user.id,
    userName: user.name,
    deptId: user.deptId,
    deptName: user.deptName,
    date,
    periodId,
    applyType,
    reason,
    status: 1,
    auditorId: null,
    auditorName: '',
    auditTime: null,
    auditRemark: '',
    createTime: now.stamp,
  };
  db.exceptions.unshift(ex);
  writeLog(db, { orderId: order.id, exceptionId: ex.id, action: '提交异常申请', after: snapshot(ex), operator: user, ip: ctx.ip, source: ctx.source });
  save();
  return ex;
}

export function auditException(user, input, ctx = {}) {
  const db = getDb();
  const ex = db.exceptions.find((e) => e.id === input.exceptionId);
  if (!ex) throw new AppError('申请不存在', 'NOT_FOUND', 404);
  if (ex.status !== 1) throw new AppError('该申请已处理', 'ALREADY_HANDLED', 409);
  const order = db.orders.find((o) => o.id === ex.orderId);
  if (!order) throw new AppError('关联报餐不存在', 'NOT_FOUND', 404);

  const approve = input.approve === true;
  const before = snapshot(order);
  ex.status = approve ? 2 : 3;
  ex.auditorId = user.id;
  ex.auditorName = user.name;
  ex.auditTime = cnNow().stamp;
  ex.auditRemark = String(input.remark || '').slice(0, 300);

  if (approve) {
    order.status = ST.PROXY;
    order.source = 3;
    order.cancelTime = null;
  } else {
    order.status = ST.CANCELLED;
    order.cancelTime = cnNow().stamp;
  }

  writeLog(db, {
    orderId: order.id,
    exceptionId: ex.id,
    action: approve ? '审核通过' : '审核驳回',
    before,
    after: snapshot(order),
    operator: user,
    ip: ctx.ip,
    source: ctx.source,
  });
  save();
  return ex;
}

export function statsByDept(db, { date, periodId, deptId = null }) {
  const rows = db.orders.filter(
    (o) => o.date === date && o.periodId === periodId && (o.status === ST.BOOKED || o.status === ST.PROXY) && (!deptId || o.deptId === deptId),
  );
  const map = new Map();
  for (const o of rows) {
    if (!map.has(o.deptId)) map.set(o.deptId, { deptId: o.deptId, deptName: o.deptName, count: 0, qty: 0 });
    const v = map.get(o.deptId);
    v.count += 1;
    v.qty += o.qty || 1;
  }
  return {
    total: rows.length,
    qty: rows.reduce((s, o) => s + (o.qty || 1), 0),
    byDept: [...map.values()].sort((a, b) => b.count - a.count),
  };
}

export function overview(db, date) {
  const periods = db.periods.filter((p) => p.status === 1).sort((a, b) => a.sort - b.sort);
  const byPeriod = periods.map((p) => {
    const s = statsByDept(db, { date, periodId: p.id });
    return { periodId: p.id, periodName: p.periodName, total: s.total, qty: s.qty, deadline: p.deadlineTime };
  });
  const pending = db.exceptions.filter((e) => e.status === 1).length;
  return { date, byPeriod, pending, total: byPeriod.reduce((s, x) => s + x.total, 0) };
}
