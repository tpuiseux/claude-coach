-- Daily recovery/wellness data from Garmin Connect. Separate database from
-- coach.db (see sync_activities.py / src/db/schema.ts) - these are Garmin-only
-- signals (sleep, HRV, stress, training readiness) with no Strava equivalent,
-- so unlike activities there's no shared schema to stay compatible with; this
-- file is the only source of truth for it. One row per calendar date.

CREATE TABLE IF NOT EXISTS daily_wellness (
  date TEXT PRIMARY KEY,             -- YYYY-MM-DD

  -- Sleep
  sleep_score INTEGER,
  sleep_seconds INTEGER,
  deep_sleep_seconds INTEGER,
  light_sleep_seconds INTEGER,
  rem_sleep_seconds INTEGER,
  awake_sleep_seconds INTEGER,
  avg_sleep_stress REAL,

  -- Stress (all-day)
  avg_stress INTEGER,
  max_stress INTEGER,

  -- Heart rate / HRV
  resting_hr INTEGER,
  hrv_last_night_avg INTEGER,
  hrv_weekly_avg INTEGER,
  hrv_status TEXT,                   -- BALANCED, UNBALANCED, LOW, etc.

  -- Body Battery
  body_battery_high INTEGER,
  body_battery_low INTEGER,

  -- Training readiness (morning reading, after wake-up reset)
  training_readiness_score INTEGER,
  training_readiness_level TEXT,     -- LOW, MODERATE, HIGH, etc.
  training_readiness_feedback TEXT,

  -- Training load / status
  acute_training_load REAL,
  chronic_training_load REAL,
  acwr REAL,                         -- acute:chronic workload ratio - injury-risk signal (>1.5 = elevated risk)
  acwr_status TEXT,                  -- OPTIMAL, HIGH, LOW, etc.
  training_status TEXT,              -- feedback phrase, e.g. UNPRODUCTIVE_5, PRODUCTIVE_3
  vo2max REAL,

  raw_json TEXT,                     -- full combined raw payload for anything not extracted above
  synced_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wellness_date ON daily_wellness(date);

-- Convenience view for a quick weekly read
DROP VIEW IF EXISTS recent_wellness;
CREATE VIEW recent_wellness AS
SELECT
  date,
  sleep_score,
  ROUND(sleep_seconds / 3600.0, 1) AS sleep_hours,
  avg_stress,
  resting_hr,
  hrv_last_night_avg,
  hrv_status,
  training_readiness_score,
  training_readiness_level,
  ROUND(acwr, 2) AS acwr,
  acwr_status,
  training_status,
  vo2max
FROM daily_wellness
ORDER BY date DESC
LIMIT 28;
