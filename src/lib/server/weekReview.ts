import { all, run } from "../../db/client.js";
import type { TrainingPlan } from "../../schema/training-plan.js";
import { deriveSettingsFromPlan } from "../settings.js";
import type { RecordedActivity, WorkoutFeedback } from "../trainingLog.js";
import { reviewWeek, type WeekReview, type WellnessDay } from "../weekReview.js";

/** Today where the athletes are - the server runs on UTC. */
export function todayLocal(timeZone = process.env.COACH_TIMEZONE || "Europe/Paris"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

export function wellnessBetween(userId: number, start: string, end: string): WellnessDay[] {
  return all<WellnessDay>(
    `SELECT date, sleep_score, resting_hr, hrv_status, training_readiness_score, acwr
     FROM daily_wellness WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
    [userId, start, end]
  );
}

type CoachNote = NonNullable<WeekReview["coachNote"]>;

export function weekNotes(userId: number, planId: string): Record<number, CoachNote> {
  const rows = all<{ week_number: number; summary: string; focus: string; updated_at: string }>(
    `SELECT week_number, summary, focus, updated_at FROM coach_week_notes
     WHERE user_id = ? AND plan_id = ?`,
    [userId, planId]
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.week_number,
      { summary: r.summary, focus: r.focus, updatedAt: r.updated_at },
    ])
  );
}

export function saveWeekNote(
  userId: number,
  planId: string,
  weekNumber: number,
  summary: string,
  focus: string
): void {
  run(
    `INSERT INTO coach_week_notes (user_id, plan_id, week_number, summary, focus)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, plan_id, week_number)
     DO UPDATE SET summary = excluded.summary, focus = excluded.focus, updated_at = datetime('now')`,
    [userId, planId, weekNumber, summary, focus]
  );
}

/** A review of every week that has started, by week number. */
export function getWeekReviews(
  userId: number,
  planId: string,
  plan: TrainingPlan,
  activitiesByDate: Record<string, RecordedActivity[]>,
  feedback: Record<string, WorkoutFeedback>
): Record<number, WeekReview> {
  const today = todayLocal();
  const started = (plan.weeks ?? []).filter((w) => w.startDate <= today);
  if (started.length === 0) return {};

  const wellness = wellnessBetween(
    userId,
    started[0].startDate,
    started[started.length - 1].endDate
  );
  const hrZones = deriveSettingsFromPlan(plan).run.hrZones;
  const notes = weekNotes(userId, planId);
  return Object.fromEntries(
    started.map((w) => [
      w.weekNumber,
      reviewWeek(
        w,
        today,
        activitiesByDate,
        feedback,
        wellness,
        hrZones,
        notes[w.weekNumber] ?? null
      ),
    ])
  );
}
