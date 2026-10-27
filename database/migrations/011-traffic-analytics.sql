CREATE TABLE traffic_views (
  id INTEGER PRIMARY KEY,
  visitor_hash TEXT NOT NULL,
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  visit_day TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  UNIQUE(visitor_hash,page_id)
);
CREATE INDEX traffic_views_day ON traffic_views(visit_day,product_id,visitor_hash);
CREATE TABLE traffic_presence (
  visitor_hash TEXT NOT NULL,
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(visitor_hash,page_id)
);
CREATE INDEX traffic_presence_seen ON traffic_presence(last_seen,product_id,visitor_hash);
