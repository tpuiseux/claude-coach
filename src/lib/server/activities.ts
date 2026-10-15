import { all } from "../../db/client.js";
import type { RecordedActivity } from "../trainingLog.js";

/** The user's activities whose local start date falls in [startDate, endDate], by date. */
export function getActivitiesByDate(
  userId: number,
  startDate: string,
  endDate: string
): Record<string, RecordedActivity[]> {
  const rows = all<{
    id: number;
    name: string | null;
    sport_type: string | null;
    start_date_local: string;
    moving_time: number | null;
    elapsed_time: number | null;
    distance: number | null;
    average_heartrate: number | null;
  }>(
    `SELECT id, name, sport_type, start_date_local, moving_time, elapsed_time, distance,
            average_heartrate
     FROM activities
     WHERE user_id = ? AND start_date_local >= ? AND start_date_local < ?
     ORDER BY start_date_local`,
    // "<" the day after endDate: start_date_local carries a time part.
    [userId, startDate, nextDay(endDate)]
  );

  const byDate: Record<string, RecordedActivity[]> = {};
  for (const r of rows) {
    const date = r.start_date_local.slice(0, 10);
    (byDate[date] ??= []).push({
      id: r.id,
      name: r.name,
      sportType: r.sport_type,
      startLocal: r.start_date_local,
      movingSeconds: r.moving_time ?? r.elapsed_time,
      distanceMeters: r.distance,
      averageHeartrate: r.average_heartrate,
    });
  }
  return byDate;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
