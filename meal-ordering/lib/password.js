// 密码哈希：scrypt + 随机盐，供登录与种子数据共用。
import crypto from 'node:crypto';

export function makePassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, pwdHash: crypto.scryptSync(String(pwd), salt, 32).toString('hex') };
}

export function checkPassword(pwd, user) {
  if (!user?.salt || !user?.pwdHash) return false;
  const hash = crypto.scryptSync(String(pwd), user.salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.pwdHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
