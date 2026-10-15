import { all, execute, runScript } from "./client.js";
import { schema } from "./schema.js";
import { ensureConfigDir } from "../lib/config.js";
import { log } from "../lib/logging.js";

// Tables that predate multi-user support and need a `user_id` FK added.
// Not in schema.sql: SQLite's ALTER TABLE ADD COLUMN isn't idempotent (a
// second run errors with "duplicate column"), unlike everything else in
// that file, so this checks first via PRAGMA table_info.
const LEGACY_TABLES_NEEDING_USER_ID = ["activities", "athlete", "goals", "sync_log"] as const;

interface TableColumn {
  name: string;
}

function migrateLegacyColumns(): void {
  for (const table of LEGACY_TABLES_NEEDING_USER_ID) {
    const columns = all<TableColumn>(`PRAGMA table_info(${table})`);
    const hasUserId = columns.some((c) => c.name === "user_id");
    if (!hasUserId) {
      execute(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id)`);
    }
  }
  execute("CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities(user_id, start_date)");

  // The athlete's local start time (Garmin's startTimeLocal) - start_date is
  // UTC, so grouping activities by plan day needs this to put an early run
  // on the right date. Only the web app's Garmin sync fills it.
  const activityColumns = all<TableColumn>("PRAGMA table_info(activities)");
  if (!activityColumns.some((c) => c.name === "start_date_local")) {
    execute("ALTER TABLE activities ADD COLUMN start_date_local TEXT");
  }
  execute(
    "CREATE INDEX IF NOT EXISTS idx_activities_user_local ON activities(user_id, start_date_local)"
  );
}

export function migrate(): void {
  ensureConfigDir();
  runScript(schema);
  migrateLegacyColumns();
  log.success("Database schema initialized");
}
