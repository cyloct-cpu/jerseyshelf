ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN base_discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_snapshot TEXT NOT NULL DEFAULT '{}';
INSERT OR IGNORE INTO settings(key,value) VALUES('quantity_promotion','{"enabled":true,"tiers":[{"quantity":3,"amount":500},{"quantity":8,"amount":1000},{"quantity":10,"amount":1800}]}');
