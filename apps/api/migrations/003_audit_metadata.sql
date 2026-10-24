ALTER TABLE llm_runs ADD COLUMN prompt_version TEXT;

CREATE TABLE IF NOT EXISTS dataset_imports (
  dataset_sha256 TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  report_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

UPDATE sources
SET published_at = published_at || 'T00:00:00+08:00'
WHERE published_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]';

CREATE TRIGGER IF NOT EXISTS trg_airport_monthly_valid_month_insert
BEFORE INSERT ON airport_monthly
WHEN CAST(substr(NEW.month, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
BEGIN
  SELECT RAISE(ABORT, 'airport_monthly month must be YYYY-MM with month 01-12');
END;

CREATE TRIGGER IF NOT EXISTS trg_weather_monthly_valid_month_insert
BEFORE INSERT ON weather_monthly
WHEN NEW.month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  OR CAST(substr(NEW.month, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
BEGIN
  SELECT RAISE(ABORT, 'weather_monthly month must be YYYY-MM with month 01-12');
END;
