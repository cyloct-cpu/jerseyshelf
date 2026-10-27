ALTER TABLE translation_jobs RENAME TO translation_jobs_legacy;
DROP INDEX translation_jobs_queue;
CREATE TABLE translation_jobs (
  id INTEGER PRIMARY KEY,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  translated_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','ready','failed','unsupported','obsolete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  blocked_providers TEXT NOT NULL DEFAULT '{}',
  requested_provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_hash,source_locale,target_locale)
);
INSERT INTO translation_jobs(id,source_hash,source_text,source_locale,target_locale,provider,translated_text,status,attempts,next_attempt,last_error,created_at,updated_at)
SELECT id,source_hash,source_text,source_locale,target_locale,provider,translated_text,status,attempts,next_attempt,last_error,created_at,updated_at FROM translation_jobs_legacy;
DROP TABLE translation_jobs_legacy;
CREATE INDEX translation_jobs_queue ON translation_jobs(status,next_attempt,target_locale,id);
CREATE TABLE translation_provider_usage (
  provider TEXT NOT NULL,
  period TEXT NOT NULL,
  characters INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,period)
);
INSERT INTO translation_provider_usage(provider,period,characters,requests)
SELECT 'mymemory',day,characters,requests FROM translation_usage;
CREATE TABLE translation_provider_state (
  provider TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  resume_at INTEGER NOT NULL DEFAULT 0,
  last_success TEXT NOT NULL DEFAULT ''
);
CREATE TABLE translation_attempts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  result TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX translation_attempts_recent ON translation_attempts(id DESC);
