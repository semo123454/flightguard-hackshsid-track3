CREATE TABLE IF NOT EXISTS airports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  published_at TEXT,
  coverage TEXT,
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'unverified', 'conflicting')),
  simulated INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS airport_monthly (
  airport_id TEXT NOT NULL REFERENCES airports(id),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  completion_ratio REAL CHECK (completion_ratio BETWEEN 0 AND 1),
  release_normal_ratio REAL CHECK (release_normal_ratio BETWEEN 0 AND 1),
  source_id TEXT NOT NULL REFERENCES sources(id),
  record_locator TEXT NOT NULL,
  PRIMARY KEY (airport_id, month)
);

CREATE TABLE IF NOT EXISTS airport_annual (
  airport_id TEXT NOT NULL REFERENCES airports(id),
  year INTEGER NOT NULL,
  passenger_volume REAL,
  movements INTEGER,
  importance TEXT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  record_locator TEXT NOT NULL,
  PRIMARY KEY (airport_id, year)
);

CREATE TABLE IF NOT EXISTS weather_monthly (
  airport_id TEXT NOT NULL REFERENCES airports(id),
  month TEXT NOT NULL,
  precipitation_mm REAL,
  mean_temperature_c REAL,
  max_wind_speed_mps REAL,
  adverse_weather_days INTEGER,
  missing_flag INTEGER NOT NULL CHECK (missing_flag IN (0, 1)),
  source_id TEXT NOT NULL REFERENCES sources(id),
  record_locator TEXT NOT NULL,
  PRIMARY KEY (airport_id, month)
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  action_text TEXT NOT NULL,
  human_approval_required INTEGER NOT NULL CHECK (human_approval_required IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_revisions (
  event_id TEXT NOT NULL REFERENCES events(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, revision)
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  revision INTEGER NOT NULL,
  parent_analysis_id TEXT REFERENCES analyses(id),
  report_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_version TEXT,
  run_mode TEXT NOT NULL CHECK (run_mode IN ('llm', 'rules_fallback')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id, revision) REFERENCES event_revisions(event_id, revision)
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'modified', 'rejected')),
  reason TEXT NOT NULL,
  added_facts_json TEXT NOT NULL,
  reviewer_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_runs (
  id TEXT PRIMARY KEY,
  analysis_id TEXT REFERENCES analyses(id),
  request_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract', 'report', 'answer')),
  mode TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  error_category TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
);

CREATE INDEX IF NOT EXISTS idx_analyses_event_revision ON analyses(event_id, revision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_analysis ON feedback(analysis_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_runs_created ON llm_runs(created_at);
