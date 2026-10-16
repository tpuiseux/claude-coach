import { all } from "../../db/client.js";
import type { TrainingPlan } from "../../schema/training-plan.js";
import { buildLoadSeries, type LoadSeries, type WellnessRow } from "../load.js";
import { todayLocal } from "./weekReview.js";

/** Days shown before the plan starts, for the load the athlete came in with. */
const LEAD_IN_DAYS = 28;
/** Activities read before the range, so computed chronic load has warmed up. */
const WARM_UP_DAYS = 60;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Load and recovery from four weeks before the plan to today (or race day). */
export function getLoadSeries(userId: number, plan: TrainingPlan): LoadSeries | null {
  const planStart = plan.meta?.planStartDate || plan.weeks?.[0]?.startDate;
  const planEnd = plan.meta?.planEndDate || plan.weeks?.[plan.weeks.length - 1]?.endDate;
  if (!planStart) return null;
  const today = todayLocal();
  const start = addDays(planStart, -LEAD_IN_DAYS);
  const end = planEnd && planEnd < today ? planEnd : today;
  if (end < start) return null;

  const wellness = all<WellnessRow>(
    `SELECT date, acute_training_load, chronic_training_load, acwr, hrv_last_night_avg,
            hrv_weekly_avg, hrv_status, sleep_score, resting_hr, training_readiness_score
     FROM daily_wellness WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
    [userId, start, end]
  );

  // Each day's summed activity load, in case Garmin's figures are missing.
  const dailyLoad: Record<string, number> = {};
  const rows = all<{ day: string; load: number | null }>(
    `SELECT substr(COALESCE(start_date_local, start_date), 1, 10) AS day,
            SUM(CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.activityTrainingLoad') END) AS load
     FROM activities
     WHERE user_id = ? AND COALESCE(start_date_local, start_date) >= ?
       AND COALESCE(start_date_local, start_date) < date(?, '+1 day')
     GROUP BY day`,
    [userId, addDays(start, -WARM_UP_DAYS), end]
  );
  for (const r of rows) if (r.load) dailyLoad[r.day] = r.load;

  if (wellness.length === 0 && Object.keys(dailyLoad).length === 0) return null;
  return buildLoadSeries(wellness, dailyLoad, start, end);
}
