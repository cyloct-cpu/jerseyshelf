CREATE TABLE saved_shipping_addresses(
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 address TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
