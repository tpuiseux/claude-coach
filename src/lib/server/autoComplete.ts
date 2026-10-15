import { all, run } from "../../db/client.js";
import { matchDay } from "../trainingLog.js";
import { getActivitiesByDate } from "./activities.js";
import { setWorkoutCompleted } from "./planMutations.js";
import { loadPlanForUser, savePlanForUser } from "./plans.js";

/**
 * Marks planned workouts completed when a recorded activity matches them
 * (same day, same sport - see matchDay). Runs after each Garmin sync and
 * after a plan import.
 *
 * Each workout is auto-completed at most once, tracked in
 * workout_auto_completions: an athlete who unticks a workout (say the
 * matched run wasn't really that session) won't see it ticked again by the
 * next sync. Returns how many workouts were newly marked completed.
 */
/** Forgets which of a plan's workouts were auto-completed - for a re-import,
 * which replaces the whole plan (completion state included), so matching
 * should start over rather than skip workouts it ticked in the old copy. */
export function resetAutoCompletions(userId: number, planId: string): void {
  run("DELETE FROM workout_auto_completions WHERE user_id = ? AND plan_id = ?", [userId, planId]);
}

export function autoCompleteFromActivities(userId: number, planIds?: string[]): number {
  const ids =
    planIds ??
    all<{ id: string }>("SELECT id FROM plans WHERE user_id = ?", [userId]).map((p) => p.id);

  let completed = 0;
  for (const planId of ids) {
    const plan = loadPlanForUser(planId, userId);
    if (!plan) continue;

    const days = (plan.weeks ?? []).flatMap((w) => w.days ?? []);
    const dates = days.map((d) => d.date).sort();
    if (dates.length === 0) continue;
    const activitiesByDate = getActivitiesByDate(userId, dates[0], dates[dates.length - 1]);

    const alreadyProcessed = new Set(
      all<{ workout_id: string }>(
        "SELECT workout_id FROM workout_auto_completions WHERE user_id = ? AND plan_id = ?",
        [userId, planId]
      ).map((r) => r.workout_id)
    );

    let changed = false;
    for (const day of days) {
      const activities = activitiesByDate[day.date];
      if (!activities) continue;

      const { byWorkout } = matchDay(day.workouts ?? [], activities);
      for (const [workoutId, matched] of Object.entries(byWorkout)) {
        if (alreadyProcessed.has(workoutId)) continue;
        // Recorded even when the workout was already ticked by hand, so a
        // later untick sticks.
        run(
          `INSERT INTO workout_auto_completions (user_id, plan_id, workout_id, activity_id)
           VALUES (?, ?, ?, ?)`,
          [userId, planId, workoutId, matched[0].id]
        );
        const workout = (day.workouts ?? []).find((w) => w.id === workoutId);
        if (workout && !workout.completed) {
          setWorkoutCompleted(plan, workoutId, true);
          changed = true;
          completed++;
        }
      }
    }
    if (changed) savePlanForUser(planId, userId, plan);
  }
  return completed;
}
