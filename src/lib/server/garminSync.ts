import { all, execute, get, run } from "../../db/client.js";
import { isGarminConnected } from "./garminCredentials.js";
import { autoCompleteFromActivities } from "./autoComplete.js";
import {
  fetchGarminActivities,
  fetchGarminWellness,
  type BridgeActivityRow,
  type BridgeWellnessRow,
} from "./garminBridge.js";

/**
 * Per-user Garmin sync for the web app: pulls activities and daily wellness
 * through the bridge (which only talks to Garmin) and stores them in this
 * app's database. Runs in the background - callers start it and poll
 * getSyncState().
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sync older than this is redone automatically when a plan is opened. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// First sync: enough history for a meaningful look back (six weeks of
// training, two of recovery - wellness costs ~6 Garmin calls per day).
const FIRST_SYNC_ACTIVITY_DAYS = 42;
const FIRST_SYNC_WELLNESS_DAYS = 14;
// Later syncs re-fetch a little before the last one: activities recorded
// offline upload late, and HRV/sleep values settle over the following day.
const OVERLAP_DAYS = 2;
// Bridge caps (garmin_bridge.py MAX_*_SYNC_DAYS).
const MAX_ACTIVITY_DAYS = 120;
const MAX_WELLNESS_DAYS = 31;

// Whitelists: these names go into SQL as identifiers, so they're never taken
// from the bridge's response keys.
const ACTIVITY_COLUMNS = [
  "id",
  "name",
  "sport_type",
  "start_date",
  "start_date_local",
  "elapsed_time",
  "moving_time",
  "distance",
  "total_elevation_gain",
  "average_speed",
  "max_speed",
  "average_heartrate",
  "max_heartrate",
  "average_watts",
  "max_watts",
  "weighted_average_watts",
  "kilojoules",
  "suffer_score",
  "average_cadence",
  "calories",
  "description",
  "workout_type",
  "gear_id",
  "raw_json",
] as const;

const WELLNESS_COLUMNS = [
  "sleep_score",
  "sleep_seconds",
  "deep_sleep_seconds",
  "light_sleep_seconds",
  "rem_sleep_seconds",
  "awake_sleep_seconds",
  "avg_sleep_stress",
  "avg_stress",
  "max_stress",
  "resting_hr",
  "hrv_last_night_avg",
  "hrv_weekly_avg",
  "hrv_status",
  "body_battery_high",
  "body_battery_low",
  "training_readiness_score",
  "training_readiness_level",
  "training_readiness_feedback",
  "acute_training_load",
  "chronic_training_load",
  "acwr",
  "acwr_status",
  "training_status",
  "vo2max",
  "raw_json",
] as const;

export interface GarminSyncState {
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at: string | null;
  last_success_at: string | null;
  activities_synced: number | null;
  wellness_days_synced: number | null;
  error: string | null;
}

// One sync per user at a time. In-memory is enough: the app runs as a single
// process, and a restart mid-sync just leaves a "running" row that the
// staleness check below treats as abandoned.
const runningSyncs = new Set<number>();

export function getSyncState(userId: number): GarminSyncState | null {
  return (
    get<GarminSyncState>(
      `SELECT status, started_at, finished_at, last_success_at, activities_synced,
              wellness_days_synced, error
       FROM garmin_sync_state WHERE user_id = ?`,
      [userId]
    ) ?? null
  );
}

export function isSyncRunning(userId: number): boolean {
  return runningSyncs.has(userId);
}

/** getSyncState(), except a "running" row with no sync actually running
 * (the server restarted mid-sync) reads as failed, so clients polling for
 * completion don't wait forever. */
export function effectiveSyncState(userId: number): GarminSyncState | null {
  const state = getSyncState(userId);
  if (state?.status === "running" && !runningSyncs.has(userId)) {
    return { ...state, status: "failed", error: state.error ?? "Sync interrupted" };
  }
  return state;
}

export function isSyncStale(state: GarminSyncState | null, now = Date.now()): boolean {
  if (!state?.last_success_at) return true;
  return now - Date.parse(state.last_success_at) > STALE_AFTER_MS;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The [start, end] dates to fetch, given when the last sync succeeded. */
export function syncRange(
  lastSuccessAt: string | null,
  firstSyncDays: number,
  maxDays: number,
  now = Date.now()
): { start: string; end: string } {
  const end = now;
  const earliest = end - (maxDays - 1) * DAY_MS;
  const start = lastSuccessAt
    ? Math.max(Date.parse(lastSuccessAt) - OVERLAP_DAYS * DAY_MS, earliest)
    : end - (firstSyncDays - 1) * DAY_MS;
  return { start: isoDate(start), end: isoDate(end) };
}

function sqlValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function storeActivities(userId: number, rows: BridgeActivityRow[], start: string, end: string) {
  const cols = ACTIVITY_COLUMNS.join(", ");
  const placeholders = ACTIVITY_COLUMNS.map(() => "?").join(", ");
  const updates = ACTIVITY_COLUMNS.filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  let stored = 0;
  for (const row of rows) {
    if (typeof row.id !== "number") continue;
    // The WHERE keeps one user's sync from ever overwriting another user's
    // row, should Garmin activity ids somehow collide.
    const result = run(
      `INSERT INTO activities (${cols}, user_id, synced_at)
       VALUES (${placeholders}, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET ${updates}, synced_at = datetime('now')
       WHERE activities.user_id = excluded.user_id`,
      [...ACTIVITY_COLUMNS.map((c) => sqlValue(row[c])), userId]
    );
    stored += Number(result.changes);
  }

  // Mirror deletions: anything this user has in the synced window that Garmin
  // no longer returns was deleted there (or was a duplicate recording).
  const keep = rows.map((r) => r.id).filter((id): id is number => typeof id === "number");
  const existing = all<{ id: number }>(
    `SELECT id FROM activities
     WHERE user_id = ? AND start_date_local >= ? AND start_date_local < ?`,
    [userId, start, isoDate(Date.parse(end) + DAY_MS)]
  );
  for (const { id } of existing) {
    if (!keep.includes(id))
      run("DELETE FROM activities WHERE id = ? AND user_id = ?", [id, userId]);
  }
  return stored;
}

function storeWellness(userId: number, rows: BridgeWellnessRow[]) {
  const cols = WELLNESS_COLUMNS.join(", ");
  const placeholders = WELLNESS_COLUMNS.map(() => "?").join(", ");
  const updates = WELLNESS_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");

  let stored = 0;
  for (const row of rows) {
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    run(
      `INSERT INTO daily_wellness (user_id, date, ${cols}, synced_at)
       VALUES (?, ?, ${placeholders}, datetime('now'))
       ON CONFLICT(user_id, date) DO UPDATE SET ${updates}, synced_at = datetime('now')`,
      [userId, row.date, ...WELLNESS_COLUMNS.map((c) => sqlValue(row[c]))]
    );
    stored++;
  }
  return stored;
}

function inTransaction<T>(fn: () => T): T {
  execute("BEGIN");
  try {
    const result = fn();
    execute("COMMIT");
    return result;
  } catch (err) {
    execute("ROLLBACK");
    throw err;
  }
}

async function runSync(userId: number, previous: GarminSyncState | null): Promise<void> {
  const lastSuccess = previous?.last_success_at ?? null;
  const activityRange = syncRange(lastSuccess, FIRST_SYNC_ACTIVITY_DAYS, MAX_ACTIVITY_DAYS);
  const wellnessRange = syncRange(lastSuccess, FIRST_SYNC_WELLNESS_DAYS, MAX_WELLNESS_DAYS);

  try {
    const activities = await fetchGarminActivities(userId, activityRange.start, activityRange.end);
    if (!activities.ok) throw new Error(activities.message);
    const activityCount = inTransaction(() =>
      storeActivities(userId, activities.data.activities, activityRange.start, activityRange.end)
    );

    const wellness = await fetchGarminWellness(userId, wellnessRange.start, wellnessRange.end);
    if (!wellness.ok) throw new Error(wellness.message);
    const wellnessCount = inTransaction(() => storeWellness(userId, wellness.data.days));

    try {
      autoCompleteFromActivities(userId);
    } catch (err) {
      // The data is stored either way; ticking workouts is a convenience.
      console.error(`[garmin-sync] auto-complete failed for user ${userId}:`, err);
    }

    run(
      `UPDATE garmin_sync_state SET status = 'success', finished_at = datetime('now'),
         last_success_at = ?, activities_synced = ?, wellness_days_synced = ?, error = NULL
       WHERE user_id = ?`,
      [new Date().toISOString(), activityCount, wellnessCount, userId]
    );
  } catch (err) {
    run(
      `UPDATE garmin_sync_state SET status = 'failed', finished_at = datetime('now'), error = ?
       WHERE user_id = ?`,
      [err instanceof Error ? err.message : String(err), userId]
    );
  } finally {
    runningSyncs.delete(userId);
  }
}

export type StartSyncResult = "started" | "running" | "fresh" | "not-connected";

/**
 * Starts a background sync and returns immediately. Without `force`, does
 * nothing when the last successful sync is recent - so it's safe to call on
 * every page load.
 */
export function startGarminSync(userId: number, { force = false } = {}): StartSyncResult {
  if (!isGarminConnected(userId)) return "not-connected";
  if (runningSyncs.has(userId)) return "running";

  const previous = getSyncState(userId);
  if (!force && !isSyncStale(previous)) return "fresh";

  runningSyncs.add(userId);
  run(
    `INSERT INTO garmin_sync_state (user_id, status, started_at)
     VALUES (?, 'running', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET status = 'running', started_at = datetime('now'),
       finished_at = NULL, error = NULL`,
    [userId]
  );
  void runSync(userId, previous);
  return "started";
}
