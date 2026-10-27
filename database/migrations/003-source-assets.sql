CREATE TABLE source_products(source_id TEXT PRIMARY KEY, product_id INTEGER NOT NULL UNIQUE REFERENCES products(id), source_slug TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE source_variants(source_id TEXT PRIMARY KEY, variant_id INTEGER NOT NULL UNIQUE REFERENCES variants(id));
