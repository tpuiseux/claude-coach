// Source of truth for the DDL - kept as a plain TS string (not read from
// schema.sql via fs at runtime) so it works identically whether this module
// runs under tsx (the CLI) or gets bundled by Vite for the SvelteKit server,
// where a readFileSync relative to the compiled file's location isn't
// reliable (Vite doesn't copy arbitrary runtime-referenced files next to
// its output chunks the way `tsc` + a manual `cp` step does for the CLI).
export const schema = `
-- Core activity data
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,           -- Strava activity ID
  name TEXT,
  sport_type TEXT,                  -- Run, Ride, Swim, etc.
  start_date TEXT,                  -- ISO 8601 UTC
  elapsed_time INTEGER,             -- seconds
  moving_time INTEGER,              -- seconds
  distance REAL,                    -- meters
  total_elevation_gain REAL,        -- meters
  average_speed REAL,               -- m/s
  max_speed REAL,                   -- m/s
  average_heartrate REAL,
  max_heartrate REAL,
  average_watts REAL,               -- cycling/running power
  max_watts REAL,
  weighted_average_watts REAL,      -- normalized power
  kilojoules REAL,
  suffer_score INTEGER,             -- Strava's relative effort
  average_cadence REAL,
  calories REAL,
  description TEXT,
  workout_type INTEGER,             -- 0=default, 1=race, 2=workout, 3=long run
  gear_id TEXT,
  raw_json TEXT,                    -- full Strava response as JSON
  synced_at TEXT DEFAULT (datetime('now'))
);

-- Time-series streams (HR, power, pace over time)
CREATE TABLE IF NOT EXISTS streams (
  activity_id INTEGER PRIMARY KEY,
  time_data TEXT,                   -- JSON array: seconds from start
  distance_data TEXT,               -- JSON array: cumulative meters
  heartrate_data TEXT,              -- JSON array
  watts_data TEXT,                  -- JSON array
  cadence_data TEXT,                -- JSON array
  altitude_data TEXT,               -- JSON array
  velocity_data TEXT,               -- JSON array: m/s
  FOREIGN KEY (activity_id) REFERENCES activities(id)
);

-- Athlete profile
CREATE TABLE IF NOT EXISTS athlete (
  id INTEGER PRIMARY KEY,
  firstname TEXT,
  lastname TEXT,
  weight REAL,                      -- kg
  ftp INTEGER,                      -- functional threshold power (watts)
  max_heartrate INTEGER,
  raw_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Training goals
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT,                  -- "Ironman 70.3 Oceanside"
  event_date TEXT,                  -- ISO 8601
  event_type TEXT,                  -- triathlon, marathon, ultra, century
  notes TEXT,                       -- constraints, injuries, etc.
  created_at TEXT DEFAULT (datetime('now'))
);

-- Sync metadata
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  completed_at TEXT,
  activities_synced INTEGER,
  status TEXT                       -- success, failed, partial
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(start_date);
CREATE INDEX IF NOT EXISTS idx_activities_sport ON activities(sport_type);
CREATE INDEX IF NOT EXISTS idx_activities_sport_date ON activities(sport_type, start_date);

-- Useful views
DROP VIEW IF EXISTS weekly_volume;
CREATE VIEW weekly_volume AS
SELECT
  strftime('%Y-W%W', start_date) AS week,
  sport_type,
  COUNT(*) AS sessions,
  ROUND(SUM(moving_time) / 3600.0, 1) AS hours,
  ROUND(SUM(distance) / 1000.0, 1) AS km,
  ROUND(AVG(average_heartrate), 0) AS avg_hr,
  ROUND(AVG(suffer_score), 0) AS avg_effort
FROM activities
GROUP BY week, sport_type
ORDER BY week DESC, sport_type;

DROP VIEW IF EXISTS recent_activities;
CREATE VIEW recent_activities AS
SELECT
  date(start_date) AS date,
  sport_type,
  name,
  moving_time / 60 AS minutes,
  ROUND(distance / 1000.0, 1) AS km,
  ROUND(average_heartrate, 0) AS hr,
  suffer_score
FROM activities
ORDER BY start_date DESC
LIMIT 50;

-- ============================================================================
-- Multi-user platform: accounts, sessions, plans
--
-- activities/athlete/goals/sync_log above predate multi-user support and
-- gain a \`user_id\` column too, but SQLite's ALTER TABLE ADD COLUMN isn't
-- idempotent (re-running it errors with "duplicate column"), which this
-- whole file otherwise relies on - so those four ADD COLUMNs live in
-- migrate.ts as a conditional step instead of here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,      -- "scrypt:<salt-hex>:<hash-hex>", see src/auth/password.ts
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- random opaque token; this *is* the cookie value
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,              -- matches TrainingPlan.meta.id
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT,
  event_date TEXT,
  data TEXT NOT NULL,               -- full TrainingPlan JSON blob
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id);

CREATE TABLE IF NOT EXISTS garmin_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tokenstore_path TEXT NOT NULL,
  connected_at TEXT DEFAULT (datetime('now'))
);

-- Last Garmin sync per user (web app only - see lib/server/garminSync.ts).
-- Activities land in \`activities\` above (user_id set), wellness in
-- daily_wellness below.
CREATE TABLE IF NOT EXISTS garmin_sync_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- running, success, failed
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_success_at TEXT,             -- drives the next sync's start date
  activities_synced INTEGER,
  wellness_days_synced INTEGER,
  error TEXT
);

-- Daily recovery signals from Garmin, one row per user per day. Same columns
-- as garmin-bridge/wellness_schema.sql (the CLI's separate wellness.db),
-- plus user_id.
CREATE TABLE IF NOT EXISTS daily_wellness (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  sleep_score INTEGER,
  sleep_seconds INTEGER,
  deep_sleep_seconds INTEGER,
  light_sleep_seconds INTEGER,
  rem_sleep_seconds INTEGER,
  awake_sleep_seconds INTEGER,
  avg_sleep_stress REAL,
  avg_stress INTEGER,
  max_stress INTEGER,
  resting_hr INTEGER,
  hrv_last_night_avg INTEGER,
  hrv_weekly_avg INTEGER,
  hrv_status TEXT,
  body_battery_high INTEGER,
  body_battery_low INTEGER,
  training_readiness_score INTEGER,
  training_readiness_level TEXT,
  training_readiness_feedback TEXT,
  acute_training_load REAL,
  chronic_training_load REAL,
  acwr REAL,
  acwr_status TEXT,
  training_status TEXT,
  vo2max REAL,
  raw_json TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

-- Workouts already marked completed because a recorded activity matched
-- them (lib/server/autoComplete.ts). Each is auto-completed at most once:
-- if the athlete unticks it afterwards, the row keeps it unticked.
CREATE TABLE IF NOT EXISTS workout_auto_completions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  workout_id TEXT NOT NULL,
  activity_id INTEGER NOT NULL,     -- the activity that matched it
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, plan_id, workout_id)
);

-- Per-activity samples (pace, heart rate, altitude... over the session) and
-- laps (lib/server/activityDetails.ts). Fetched from Garmin right after each
-- sync for activities not stored yet (a few per sync, newest first), and on
-- demand when the athlete opens one that hasn't been fetched. \`data\` is the
-- bridge's JSON (garmin_bridge.py activity_details), location left out.
-- complete = 0 while Garmin was still processing the upload (or the fetch
-- failed): it's fetched again, up to a few attempts, so one activity Garmin
-- can't serve doesn't hold up the others for good.
CREATE TABLE IF NOT EXISTS activity_details (
  activity_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- How a workout actually felt, as reported by the athlete. Kept apart from
-- the plan JSON on purpose: re-importing a plan replaces the whole JSON, and
-- feedback must survive that. Keyed by the workout's id within its plan.
CREATE TABLE IF NOT EXISTS workout_feedback (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  workout_id TEXT NOT NULL,
  rpe INTEGER,                      -- 1-10, perceived effort
  feeling TEXT,                     -- great, good, ok, hard, awful
  pain INTEGER NOT NULL DEFAULT 0,  -- 0/1: any pain or niggle
  pain_notes TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, plan_id, workout_id)
);
`;
