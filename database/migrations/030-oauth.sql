-- 030 Google OAuth 登录：绑定外部身份
ALTER TABLE users ADD COLUMN oauth_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN oauth_sub TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_users_oauth ON users(oauth_provider,oauth_sub) WHERE oauth_provider<>'';
