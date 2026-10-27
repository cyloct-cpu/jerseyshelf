CREATE TABLE translation_jobs (
  id INTEGER PRIMARY KEY,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mymemory',
  translated_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','ready','failed','unsupported','obsolete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_hash,source_locale,target_locale,provider)
);
CREATE INDEX translation_jobs_queue ON translation_jobs(status,next_attempt,target_locale,id);
CREATE TABLE translation_usage (
  day TEXT PRIMARY KEY,
  characters INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0
);
