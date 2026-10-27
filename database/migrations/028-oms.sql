-- 028 OMS 履约对接与 17TRACK 同步
CREATE TABLE oms_orders(
 order_id TEXT PRIMARY KEY REFERENCES orders(id),
 oms_order_number TEXT NOT NULL DEFAULT '',
 tracking_number TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'created',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE oms_queue(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id TEXT NOT NULL,
 op TEXT NOT NULL CHECK(op IN('create','track','cancel','block','label')),
 payload TEXT NOT NULL DEFAULT '{}',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done','failed')),
 last_error TEXT NOT NULL DEFAULT '',
 actor_id INTEGER,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_oms_queue_due ON oms_queue(status,next_attempt);
CREATE TABLE oms_labels(
 order_id TEXT NOT NULL,
 tracking_number TEXT NOT NULL,
 url TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 PRIMARY KEY(order_id,tracking_number)
);
