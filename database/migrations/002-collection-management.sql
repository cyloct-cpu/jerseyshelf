ALTER TABLE collections ADD COLUMN deleted_at TEXT;
ALTER TABLE collections ADD COLUMN home_featured INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_collections_deleted ON collections(deleted_at);
