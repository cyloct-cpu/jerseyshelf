-- 033 批次工作区：上传批次可回滚，记录工作区路径、图片数与草稿模式
CREATE TABLE import_batches_new(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 batch_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL DEFAULT 'upload' CHECK(kind IN('json','csv','upload')),
 label TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN('preview','imported','failed','rolled_back')),
 total INTEGER NOT NULL DEFAULT 0,
 created_products INTEGER NOT NULL DEFAULT 0,
 updated_products INTEGER NOT NULL DEFAULT 0,
 skipped_products INTEGER NOT NULL DEFAULT 0,
 images INTEGER NOT NULL DEFAULT 0,
 draft INTEGER NOT NULL DEFAULT 0,
 report TEXT NOT NULL DEFAULT '',
 workspace TEXT NOT NULL DEFAULT '',
 actor_id INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL
);
INSERT INTO import_batches_new(id,batch_id,kind,label,status,total,created_products,updated_products,skipped_products,report,actor_id,created_at)
 SELECT id,'legacy-'||id,kind,label,status,total,created_products,updated_products,skipped_products,report,actor_id,created_at FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_new RENAME TO import_batches;
