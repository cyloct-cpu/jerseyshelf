-- 029 邮件通知：Resend 出站队列（订单确认 / 发货 / 退款确认）
CREATE TABLE email_messages(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 dedupe_key TEXT NOT NULL UNIQUE,
 order_id TEXT NOT NULL DEFAULT '',
 customer_id INTEGER,
 to_email TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('order_paid','shipped','refund','custom')),
 locale TEXT NOT NULL DEFAULT 'en',
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '',
 platform_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_email_due ON email_messages(status,next_attempt);
