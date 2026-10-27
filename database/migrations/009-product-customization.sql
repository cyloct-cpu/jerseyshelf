ALTER TABLE products ADD COLUMN customization TEXT NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN customization TEXT NOT NULL DEFAULT '{}';
