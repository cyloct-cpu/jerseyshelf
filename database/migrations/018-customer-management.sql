CREATE TABLE customers(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT UNIQUE,
 phone TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'manual', whatsapp_status TEXT NOT NULL DEFAULT 'unknown' CHECK(whatsapp_status IN('unknown','not_contacted','connected','invalid')),
 whatsapp_verified_at TEXT NOT NULL DEFAULT '', whatsapp_verified_by INTEGER REFERENCES users(id),
 last_contact_at TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
 do_not_contact INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'test' CHECK(order_kind IN('test','external'));
ALTER TABLE orders ADD COLUMN delivered_at TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN paid_at TEXT NOT NULL DEFAULT '';
CREATE TABLE customer_events(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),order_id TEXT REFERENCES orders(id),kind TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',actor_id INTEGER REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE customer_tasks(
 id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),order_id TEXT REFERENCES orders(id),
 kind TEXT NOT NULL CHECK(kind IN('first_contact','purchase','payment','delivery','review','aftersale')),
 title TEXT NOT NULL,due_at TEXT NOT NULL,owner TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done','cancelled')),
 result TEXT NOT NULL DEFAULT '',actor_id INTEGER REFERENCES users(id),
 dedupe_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE customer_cases(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),order_id TEXT NOT NULL REFERENCES orders(id),category TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','processing','waiting','resolved','closed')),owner TEXT NOT NULL DEFAULT '',due_at TEXT NOT NULL,resolution TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE order_receipts(id INTEGER PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT NOT NULL CHECK(kind IN('receipt','refund')),amount INTEGER NOT NULL CHECK(amount>0),currency TEXT NOT NULL,method TEXT NOT NULL,reference TEXT NOT NULL,occurred_at TEXT NOT NULL,actor_id INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_created ON customers(created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_users_customer ON users(customer_id);
CREATE INDEX idx_customer_events ON customer_events(customer_id,id);
CREATE INDEX idx_customer_tasks_due ON customer_tasks(status,due_at);
CREATE INDEX idx_customer_tasks_customer ON customer_tasks(customer_id,status);
CREATE INDEX idx_customer_cases ON customer_cases(customer_id,status);
CREATE INDEX idx_order_receipts ON order_receipts(order_id);
