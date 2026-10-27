CREATE TABLE shipments(
 id INTEGER PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 carrier TEXT NOT NULL DEFAULT 'other',
 carrier_name TEXT NOT NULL DEFAULT '',
 tracking_number TEXT NOT NULL,
 shipped_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'info_received',
 provider TEXT NOT NULL DEFAULT 'manual',
 provider_reference TEXT NOT NULL DEFAULT '',
 sync_status TEXT NOT NULL DEFAULT 'not_connected',
 last_synced_at TEXT NOT NULL DEFAULT '',
 sync_error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(order_id,tracking_number)
);
CREATE INDEX shipments_order ON shipments(order_id);
CREATE TABLE shipment_items(
 shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 order_item_id INTEGER NOT NULL REFERENCES order_items(id),
 quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(shipment_id,order_item_id)
);
CREATE TABLE shipment_events(
 id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 provider_event_id TEXT, status TEXT NOT NULL, description TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(shipment_id,provider_event_id)
);
CREATE TABLE shipment_changes(
 id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), before_json TEXT NOT NULL,
 after_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE tracking_access(
 order_id TEXT NOT NULL REFERENCES orders(id), session_hash TEXT NOT NULL,
 expires INTEGER NOT NULL, PRIMARY KEY(order_id,session_hash)
);
INSERT INTO shipments(order_id,tracking_number,shipped_at,status,created_at,updated_at)
 SELECT id,tracking,'',CASE WHEN delivered_at<>'' THEN 'delivered' ELSE 'unknown' END,created_at,created_at
 FROM orders WHERE tracking<>'' AND fulfillment_status='shipped';
INSERT INTO shipment_items(shipment_id,order_item_id,quantity)
 SELECT s.id,oi.id,oi.quantity FROM shipments s JOIN order_items oi ON oi.order_id=s.order_id;
