// 内置演示数据。首次启动（数据库文件不存在）时自动生成，便于直接部署体验。
import { makePassword } from './password.js';
import { cnNow, addDays, weekday } from './util.js';

export function buildSeed() {
  const now = cnNow();
  const today = now.date;
  const stamp = now.stamp;

  const depts = [
    { id: 'D00', name: '后勤服务中心' },
    { id: 'D01', name: '办公室' },
    { id: 'D02', name: '人事处' },
    { id: 'D03', name: '财务处' },
    { id: 'D04', name: '综合处' },
  ];

  const pwd = makePassword('123456');
  const mkUser = (account, name, deptId, role) => ({
    id: `u_${account}`,
    account,
    name,
    deptId,
    deptName: depts.find((d) => d.id === deptId).name,
    role,
    active: true,
    ...pwd,
  });

  const users = [
    mkUser('9999', '系统管理员', 'D00', 'admin'),
    mkUser('9001', '食堂管理员', 'D00', 'manager'),
    mkUser('1001', '张伟', 'D01', 'staff'),
    mkUser('1002', '李娜', 'D02', 'staff'),
    mkUser('1003', '王强', 'D03', 'leader'),
    mkUser('1004', '赵敏', 'D04', 'staff'),
    mkUser('1005', '陈晨', 'D01', 'staff'),
  ];

  const periods = [
    { id: 'B', periodCode: 'B', periodName: '早餐', serveStart: '07:00', serveEnd: '08:30', deadlineTime: '06:30', deadlineDayOffset: 0, sort: 1, status: 1 },
    { id: 'L', periodCode: 'L', periodName: '午餐', serveStart: '11:30', serveEnd: '13:00', deadlineTime: '09:30', deadlineDayOffset: 0, sort: 2, status: 1 },
    { id: 'D', periodCode: 'D', periodName: '晚餐', serveStart: '17:30', serveEnd: '19:00', deadlineTime: '15:00', deadlineDayOffset: 0, sort: 3, status: 1 },
  ];

  const rules = [
    { id: 'rule_1_all', scopeType: 1, deptId: null, advanceDays: 7, allowModify: 1, allowCancel: 1, overduePolicy: 1, maxQtyPerMeal: 2, remindEnabled: 1 },
    { id: 'rule_2_D02', scopeType: 2, deptId: 'D02', advanceDays: 3, allowModify: 1, allowCancel: 0, overduePolicy: 1, maxQtyPerMeal: 1, remindEnabled: 1 },
  ];

  const calendar = {};
  for (let i = -14; i <= 30; i += 1) {
    const date = addDays(today, i);
    const w = weekday(date);
    const weekend = w === 0 || w === 6;
    calendar[date] = { dayType: weekend ? 2 : 1, isMealDay: weekend ? 0 : 1, remark: weekend ? '周末' : '' };
  }

  const lunchSets = [
    ['红烧排骨', '清炒时蔬', '番茄蛋汤', '米饭', '苹果'],
    ['清蒸鲈鱼', '干煸豆角', '紫菜蛋花汤', '米饭', '酸奶'],
    ['土豆牛腩', '蒜蓉西兰花', '冬瓜丸子汤', '米饭', '香蕉'],
    ['宫保鸡丁', '上汤娃娃菜', '萝卜排骨汤', '杂粮饭', '橘子'],
    ['梅菜扣肉', '清炒油麦菜', '菌菇汤', '米饭', '梨'],
  ];
  const breakfastSets = [
    ['小笼包', '茶叶蛋', '豆浆', '凉拌黄瓜'],
    ['燕麦粥', '全麦面包', '鸡蛋', '牛奶'],
    ['牛肉粉', '煎蛋', '豆浆'],
  ];
  const dinnerSets = [
    ['糖醋里脊', '清炒菠菜', '海带汤', '米饭'],
    ['香菇滑鸡', '蒜蓉生菜', '玉米排骨汤', '米饭'],
    ['鱼香肉丝', '清炒藕片', '紫菜汤', '米饭'],
  ];

  const menus = [];
  const dishType = ['主荤', '素菜', '汤羹', '主食', '水果'];
  const buildMenu = (date, period, names, status = 2) => {
    menus.push({
      id: `menu_${date}_${period.id}`,
      date,
      periodId: period.id,
      title: `${period.periodName}菜单`,
      status,
      publishTime: status === 2 ? stamp : null,
      publishUserId: status === 2 ? 'u_9001' : null,
      remark: '',
      items: names.map((name, idx) => ({
        id: `dish_${date}_${period.id}_${idx}`,
        name,
        type: dishType[idx] || '配菜',
        price: 0,
        isMain: idx === 0,
        sort: idx + 1,
      })),
    });
  };

  for (let i = 0; i <= 7; i += 1) {
    const date = addDays(today, i);
    buildMenu(date, periods[1], lunchSets[i % lunchSets.length]);
    if (i <= 3) {
      buildMenu(date, periods[0], breakfastSets[i % breakfastSets.length]);
      buildMenu(date, periods[2], dinnerSets[i % dinnerSets.length]);
    }
  }
  buildMenu(addDays(today, 8), periods[1], lunchSets[1], 1);

  const order = (account, date, periodId, status = 1, qty = 1, remark = '') => {
    const u = users.find((x) => x.account === account);
    return {
      id: `ord_${account}_${date}_${periodId}`,
      userId: u.id,
      userName: u.name,
      deptId: u.deptId,
      deptName: u.deptName,
      date,
      periodId,
      status,
      source: 1,
      qty,
      remark,
      submitTime: stamp,
      cancelTime: status === 2 ? stamp : null,
      lockTime: null,
      idempotencyKey: '',
    };
  };

  const orders = [
    order('1001', today, 'L'),
    order('1002', today, 'L'),
    order('1004', today, 'L'),
    order('1005', today, 'L'),
    order('1003', today, 'L', 2),
    order('1002', today, 'B'),
    order('1001', addDays(today, 1), 'L'),
    order('1002', addDays(today, 1), 'L'),
    order('1003', addDays(today, 1), 'L'),
    order('1005', addDays(today, 1), 'L'),
  ];

  const pendingOrder = order('1005', today, 'D', 3);
  orders.push(pendingOrder);

  const exceptions = [{
    id: 'exc_demo_1',
    orderId: pendingOrder.id,
    userId: pendingOrder.userId,
    userName: pendingOrder.userName,
    deptId: pendingOrder.deptId,
    deptName: pendingOrder.deptName,
    date: today,
    periodId: 'D',
    applyType: 1,
    reason: '下午临时加班，需补报晚餐',
    status: 1,
    auditorId: null,
    auditorName: '',
    auditTime: null,
    auditRemark: '',
    createTime: stamp,
  }];

  return {
    version: 1,
    createdAt: stamp,
    depts,
    users,
    periods,
    rules,
    calendar,
    menus,
    orders,
    exceptions,
    logs: [],
    sessions: {},
  };
}
