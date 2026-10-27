import { db, now } from './db.mjs';
// 按邮箱维度的登录防爆破：连续失败 MAX_FAILS 次锁定 LOCK_MS，成功登录清零。
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
export const LOCK_MINUTES = LOCK_MS / 60000;

export function loginLocked(email) {
  const row = db.prepare('SELECT locked_until FROM login_failures WHERE email=?').get(email);
  return !!(row && row.locked_until > Date.now());
}

export function recordLoginFailure(email) {
  const row = db.prepare('SELECT fails FROM login_failures WHERE email=?').get(email);
  const fails = (row?.fails || 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
  db.prepare('INSERT INTO login_failures(email,fails,locked_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET fails=excluded.fails,locked_until=excluded.locked_until,updated_at=excluded.updated_at').run(email, fails, lockedUntil, now());
  return lockedUntil > 0;
}

export function clearLoginFailures(email) {
  db.prepare('DELETE FROM login_failures WHERE email=?').run(email);
}
