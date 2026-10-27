-- 031 批量导入批次记录
CREATE TABLE import_batches(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL DEFAULT 'csv' CHECK(kind IN('json','csv')),
 label TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN('preview','imported','failed')),
 total INTEGER NOT NULL DEFAULT 0,
 created_products INTEGER NOT NULL DEFAULT 0,
 updated_products INTEGER NOT NULL DEFAULT 0,
 skipped_products INTEGER NOT NULL DEFAULT 0,
 report TEXT NOT NULL DEFAULT '',
 actor_id INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL
);
