import { all, get, run } from "../../db/client.js";
import { fetchGarminActivityDetails } from "./garminBridge.js";
import type {
  ActivityAnalysis,
  ActivityLap,
  ActivitySeries,
  ActivityStats,
} from "../activityAnalysis.js";

/**
 * One activity in detail, for the activity analysis panel. Summary numbers
 * come from the synced row; samples and laps from Garmin, fetched through
 * the bridge the first time the activity is opened and cached in
 * activity_details from then on.
 */

interface ActivityRow {
  sport_type: string | null;
  distance: number | null;
  moving_time: number | null;
  elapsed_time: number | null;
  average_speed: number | null;
  max_speed: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  total_elevation_gain: number | null;
  average_cadence: number | null;
  average_watts: number | null;
  weighted_average_watts: number | null;
  calories: number | null;
  raw_json: string | null;
}

const SERIES_NAMES = [
  "time",
  "distance",
  "speed",
  "heartrate",
  "altitude",
  "cadence",
  "power",
] as const;

export type ActivityDetailsResult =
  | { ok: true; analysis: ActivityAnalysis }
  | { ok: false; status: number; message: string };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statsFromRow(row: ActivityRow): ActivityStats {
  let raw: Record<string, unknown> = {};
  try {
    raw = row.raw_json ? JSON.parse(row.raw_json) : {};
  } catch {
    // Old or hand-edited rows: the columns are enough.
  }
  const label = raw.trainingEffectLabel;
  return {
    sportType: row.sport_type,
    distanceMeters: row.distance,
    movingSeconds: row.moving_time,
    elapsedSeconds: row.elapsed_time,
    averageSpeed: row.average_speed,
    maxSpeed: row.max_speed,
    averageHeartrate: row.average_heartrate,
    maxHeartrate: row.max_heartrate,
    elevationGain: row.total_elevation_gain,
    averageCadence: row.average_cadence,
    averagePower: row.average_watts,
    normalizedPower: row.weighted_average_watts,
    calories: row.calories,
    aerobicEffect: numberOrNull(raw.aerobicTrainingEffect),
    anaerobicEffect: numberOrNull(raw.anaerobicTrainingEffect),
    trainingLoad: numberOrNull(raw.activityTrainingLoad),
    trainingEffectLabel: typeof label === "string" ? label : null,
  };
}

/** Keeps only known series of numbers/nulls - this is bridge (or cached) output. */
function cleanSeries(input: unknown): ActivitySeries {
  const out: ActivitySeries = {};
  if (!input || typeof input !== "object") return out;
  const source = input as Record<string, unknown>;
  for (const name of SERIES_NAMES) {
    const values = source[name];
    if (Array.isArray(values)) out[name] = values.map(numberOrNull);
  }
  return out;
}

function cleanLaps(input: unknown): ActivityLap[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((lap): lap is Record<string, unknown> => !!lap && typeof lap === "object")
    .map((lap) => {
      const out: ActivityLap = {};
      for (const key of [
        "distance",
        "duration",
        "movingDuration",
        "averageSpeed",
        "averageHR",
        "maxHR",
        "averageCadence",
        "averagePower",
        "elevationGain",
      ] as const) {
        const value = numberOrNull(lap[key]);
        if (value !== null) out[key] = value;
      }
      if (typeof lap.intensityType === "string") out.intensityType = lap.intensityType;
      return out;
    });
}

/** Failed or partial fetches are retried this many times in total, then
 * left to on-demand fetches only. */
const MAX_ATTEMPTS = 3;

interface StoredDetails {
  data: string | null;
  complete: number;
}

function parseStored(data: string): { series: ActivitySeries; laps: ActivityLap[] } {
  const parsed = JSON.parse(data);
  return { series: cleanSeries(parsed.series), laps: cleanLaps(parsed.laps) };
}

type FetchResult =
  | { ok: true; series: ActivitySeries; laps: ActivityLap[]; complete: boolean }
  | { ok: false; status: number; message: string };

/** Fetches one activity's details through the bridge and stores them -
 * complete or not, so attempts are counted either way. */
async function fetchAndStore(userId: number, activityId: number): Promise<FetchResult> {
  const fetched = await fetchGarminActivityDetails(userId, activityId);
  if (!fetched.ok) {
    // Keep whatever an earlier attempt stored; just count this one.
    run(
      `INSERT INTO activity_details (activity_id, user_id, attempts, fetched_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(activity_id) DO UPDATE SET attempts = attempts + 1, fetched_at = datetime('now')
       WHERE activity_details.user_id = excluded.user_id`,
      [activityId, userId]
    );
    return fetched;
  }

  const series = cleanSeries(fetched.data.series);
  const laps = cleanLaps(fetched.data.laps);
  const complete = fetched.data.complete === true;
  run(
    `INSERT INTO activity_details (activity_id, user_id, data, complete, attempts, fetched_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(activity_id) DO UPDATE SET data = excluded.data, complete = excluded.complete,
       attempts = attempts + 1, fetched_at = datetime('now')
     WHERE activity_details.user_id = excluded.user_id`,
    [activityId, userId, JSON.stringify({ series, laps }), complete ? 1 : 0]
  );
  return { ok: true, series, laps, complete };
}

export async function getActivityDetails(
  userId: number,
  activityId: number
): Promise<ActivityDetailsResult> {
  const row = get<ActivityRow>(
    `SELECT sport_type, distance, moving_time, elapsed_time, average_speed, max_speed,
            average_heartrate, max_heartrate, total_elevation_gain, average_cadence,
            average_watts, weighted_average_watts, calories, raw_json
     FROM activities WHERE id = ? AND user_id = ?`,
    [activityId, userId]
  );
  if (!row) return { ok: false, status: 404, message: "Activity not found" };
  const stats = statsFromRow(row);

  const stored = get<StoredDetails>(
    "SELECT data, complete FROM activity_details WHERE activity_id = ? AND user_id = ?",
    [activityId, userId]
  );
  if (stored?.complete && stored.data) {
    return { ok: true, analysis: { stats, ...parseStored(stored.data) } };
  }

  // Not fetched yet, or only partly: ask Garmin now (the athlete is looking).
  const fetched = await fetchAndStore(userId, activityId);
  if (fetched.ok) {
    return { ok: true, analysis: { stats, series: fetched.series, laps: fetched.laps } };
  }
  // A partial copy beats none; the summary alone beats an error.
  const partial = stored?.data ? parseStored(stored.data) : { series: {}, laps: [] };
  return { ok: true, analysis: { stats, ...partial, detailsError: fetched.message } };
}

/**
 * Fetches details for up to `limit` of the user's activities that don't
 * have complete ones yet, newest first - run after each sync so opening a
 * session is instant. Older history fills in a few at a time over later
 * syncs. Stops at the first failure - a rate limit, an expired session or
 * the bridge being down would fail every further call the same way, and the
 * next sync carries on. An activity Garmin can never serve stops counting
 * after MAX_ATTEMPTS, so it can't hold the others up for long.
 * Returns how many were fetched.
 */
export async function prefetchActivityDetails(userId: number, limit: number): Promise<number> {
  const pending = all<{ id: number }>(
    `SELECT a.id FROM activities a
     LEFT JOIN activity_details d ON d.activity_id = a.id
     WHERE a.user_id = ? AND a.start_date_local IS NOT NULL
       AND (d.activity_id IS NULL OR (d.complete = 0 AND d.attempts < ?))
     ORDER BY a.start_date_local DESC
     LIMIT ?`,
    [userId, MAX_ATTEMPTS, limit]
  );

  let fetched = 0;
  for (const { id } of pending) {
    const result = await fetchAndStore(userId, id);
    if (!result.ok) break;
    fetched++;
  }
  return fetched;
}
