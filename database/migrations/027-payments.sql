-- 027 在线支付：Stripe / PayPal 支付会话与回调记录
ALTER TABLE orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_reference TEXT NOT NULL DEFAULT '';
CREATE TABLE payment_sessions(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK(provider IN('stripe','paypal')),
  provider_ref TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payment_sessions_order ON payment_sessions(order_id);
