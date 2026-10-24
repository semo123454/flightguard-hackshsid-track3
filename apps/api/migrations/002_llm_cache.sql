CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('report', 'answer')),
  value_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_expiry ON llm_cache(expires_at);
