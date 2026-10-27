CREATE TABLE IF NOT EXISTS source_collections(source_id TEXT PRIMARY KEY, collection_id INTEGER NOT NULL UNIQUE REFERENCES collections(id), source_slug TEXT NOT NULL);
