// 初始化演示数据。会覆盖当前数据文件，仅用于本地体验与测试。
import { replaceDb } from './lib/store.js';
import { buildSeed } from './lib/seed-data.js';

replaceDb(buildSeed());

console.log('演示数据已生成');
console.log('登录账号（密码均为 123456）：');
console.log('  职工   1001 张伟 / 1002 李娜 / 1004 赵敏 / 1005 陈晨');
console.log('  负责人 1003 王强（财务处，只读本部门）');
console.log('  管理员 9001 食堂管理员   9999 系统管理员');
