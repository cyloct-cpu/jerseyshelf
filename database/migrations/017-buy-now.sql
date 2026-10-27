CREATE TABLE direct_purchases (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  line TEXT NOT NULL,
  expires INTEGER NOT NULL,
  order_id TEXT REFERENCES orders(id),
  created_at TEXT NOT NULL
);
CREATE INDEX direct_purchases_session ON direct_purchases(session_hash, expires);
ALTER TABLE checkout_quotes ADD COLUMN source TEXT NOT NULL DEFAULT 'cart';
ALTER TABLE orders ADD COLUMN note TEXT NOT NULL DEFAULT '';
