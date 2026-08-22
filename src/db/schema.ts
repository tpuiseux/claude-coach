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
`;
