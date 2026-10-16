import { all, get } from "../../db/client.js";
import type { TrainingPlan } from "../../schema/training-plan.js";
import type { ActivitySeries } from "../activityAnalysis.js";
import {
  raceTarget,
  racePrediction,
  summarizeRun,
  type RacePrediction,
  type RunSummary,
} from "../racePrediction.js";

/**
 * The plan's race-time prediction, from the user's synced runs and Garmin
 * VO2max (lib/racePrediction.ts does the maths). Recomputed on every plan
 * load, so it moves as soon as a sync brings new runs in.
 */

const RUN_TYPES = ["Run", "TrailRun", "VirtualRun"];

/** How much history is read: enough for the earliest weekly point's window. */
const HISTORY_DAYS = 56 + 56 + 7 * 30;

interface RunRow {
  id: number;
  start: string;
  distance: number | null;
  moving_time: number | null;
  elapsed_time: number | null;
  fetched_at: string | null;
}

/**
 * Run summaries by activity id, with what they were made from. Reading
 * every run's samples on every page load would be wasteful; a summary only
 * changes when the run is synced or its details fetched again.
 */
const summaries = new Map<number, { source: string; summary: RunSummary }>();

function loadSeries(userId: number, activityId: number): ActivitySeries | null {
  const row = get<{ data: string | null }>(
    "SELECT data FROM activity_details WHERE activity_id = ? AND user_id = ?",
    [activityId, userId]
  );
  if (!row?.data) return null;
  try {
    return (JSON.parse(row.data) as { series?: ActivitySeries }).series ?? null;
  } catch {
    return null;
  }
}

function loadRuns(userId: number, since: string): RunSummary[] {
  const rows = all<RunRow>(
    `SELECT a.id, COALESCE(a.start_date_local, a.start_date) AS start, a.distance,
            a.moving_time, a.elapsed_time, d.fetched_at
     FROM activities a
     LEFT JOIN activity_details d ON d.activity_id = a.id AND d.user_id = a.user_id
     WHERE a.user_id = ? AND a.sport_type IN (${RUN_TYPES.map(() => "?").join(", ")})
       AND COALESCE(a.start_date_local, a.start_date) >= ?`,
    [userId, ...RUN_TYPES, since]
  );

  return rows.map((row) => {
    const source = [row.start, row.distance, row.moving_time, row.fetched_at].join("|");
    const cached = summaries.get(row.id);
    if (cached?.source === source) return cached.summary;
    const summary = summarizeRun(
      {
        id: row.id,
        date: row.start.slice(0, 10),
        distanceMeters: row.distance ?? 0,
        movingSeconds: row.moving_time ?? row.elapsed_time ?? 0,
      },
      row.fetched_at ? loadSeries(userId, row.id) : null
    );
    summaries.set(row.id, { source, summary });
    return summary;
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getRacePrediction(userId: number, plan: TrainingPlan): RacePrediction | null {
  const target = raceTarget(plan);
  if (!target) return null;

  const end = today();
  const since = new Date(Date.parse(`${end}T00:00:00Z`) - HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const runs = loadRuns(userId, since);
  const vo2max = all<{ date: string; value: number }>(
    `SELECT date, vo2max AS value FROM daily_wellness
     WHERE user_id = ? AND vo2max IS NOT NULL AND date >= ?`,
    [userId, since]
  );
  if (runs.length === 0 && vo2max.length === 0) return null;

  return racePrediction(
    target,
    runs,
    vo2max,
    end,
    plan.meta?.planStartDate ?? "",
    plan.meta?.eventDate ?? ""
  );
}
