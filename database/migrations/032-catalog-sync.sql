-- 032 商品主从同步：变更 outbox（jerseyshelf 为发布方）
CREATE TABLE catalog_changes(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 product_id INTEGER NOT NULL,
 op TEXT NOT NULL CHECK(op IN('product','collection')),
 created_at TEXT NOT NULL
);
CREATE INDEX idx_catalog_changes_product ON catalog_changes(product_id);
