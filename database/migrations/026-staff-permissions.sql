-- 026 员工与权限基座：多管理员细粒度权限 + 登录防爆破锁定
ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]';
-- 存量管理员全部升级为 owner，避免升级后现有管理员失去后台权限。
UPDATE users SET permissions='["owner"]' WHERE role='admin';
CREATE TABLE login_failures(
  email TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
