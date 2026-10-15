import type {
  TrainingPlan,
  Workout,
  AthleteZones,
  UnitPreferences,
} from "../../schema/training-plan.js";

/**
 * Direct, immediate mutations on a plan object - the server-side successor
 * to the old app's two duplicate "accumulate changes, merge at export time"
 * implementations (cli.ts's applyChangesToPlan and viewer/lib/UpdatePlan.ts's
 * applyLocalChangesToPlan). Since the DB row is now the single source of
 * truth (not a localStorage overlay reconciled later), each mutation just
 * edits the plan in place and the caller persists it immediately via
 * savePlanForUser - there's no separate "changes" structure to maintain.
 */

class WorkoutNotFoundError extends Error {
  constructor(workoutId: string) {
    super(`Workout ${workoutId} not found in this plan`);
  }
}

function findWorkout(
  plan: TrainingPlan,
  workoutId: string
): { workout: Workout; workouts: Workout[]; index: number } | null {
  for (const week of plan.weeks ?? []) {
    for (const day of week.days ?? []) {
      const index = (day.workouts ?? []).findIndex((w) => w.id === workoutId);
      if (index !== -1) {
        return { workout: day.workouts[index], workouts: day.workouts, index };
      }
    }
  }
  return null;
}

export function toggleWorkoutComplete(plan: TrainingPlan, workoutId: string): TrainingPlan {
  const found = findWorkout(plan, workoutId);
  if (!found) throw new WorkoutNotFoundError(workoutId);

  found.workout.completed = !found.workout.completed;
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

/** Idempotent counterpart to toggleWorkoutComplete, for callers that know the
 * state they want (e.g. logging feedback implies the workout was done). */
export function setWorkoutCompleted(
  plan: TrainingPlan,
  workoutId: string,
  completed: boolean
): TrainingPlan {
  const found = findWorkout(plan, workoutId);
  if (!found) throw new WorkoutNotFoundError(workoutId);
  if (found.workout.completed === completed) return plan;

  found.workout.completed = completed;
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

export function moveWorkout(plan: TrainingPlan, workoutId: string, newDate: string): TrainingPlan {
  const found = findWorkout(plan, workoutId);
  if (!found) throw new WorkoutNotFoundError(workoutId);

  const targetDay = (plan.weeks ?? [])
    .flatMap((week) => week.days ?? [])
    .find((day) => day.date === newDate);
  if (!targetDay) {
    throw new Error(`No day with date ${newDate} exists in this plan`);
  }

  found.workouts.splice(found.index, 1);
  (targetDay.workouts ??= []).push(found.workout);
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

export function editWorkout(
  plan: TrainingPlan,
  workoutId: string,
  updates: Partial<Workout>
): TrainingPlan {
  const found = findWorkout(plan, workoutId);
  if (!found) throw new WorkoutNotFoundError(workoutId);

  // Routes validate updates with parseWorkoutUpdates first (validation.ts);
  // identity fields are dropped here too, so no caller can ever repoint a
  // workout's id (duplicates break findWorkout) or bypass toggle-complete.
  const { id: _id, completed: _completed, ...safeUpdates } = updates;
  Object.assign(found.workout, safeUpdates);
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

export function deleteWorkout(plan: TrainingPlan, workoutId: string): TrainingPlan {
  const found = findWorkout(plan, workoutId);
  if (!found) throw new WorkoutNotFoundError(workoutId);

  found.workouts.splice(found.index, 1);
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

export function addWorkout(plan: TrainingPlan, date: string, workout: Workout): TrainingPlan {
  const targetDay = (plan.weeks ?? [])
    .flatMap((week) => week.days ?? [])
    .find((day) => day.date === date);
  if (!targetDay) {
    throw new Error(`No day with date ${date} exists in this plan`);
  }

  (targetDay.workouts ??= []).push(workout);
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}

/**
 * Full replace of zones/preferences, not a deep merge - the client (Settings
 * UI) always holds a complete Settings copy derived from the current plan,
 * so it can round-trip a complete AthleteZones/UnitPreferences back rather
 * than requiring partial-merge logic here.
 */
export function updatePlanSettings(
  plan: TrainingPlan,
  update: { preferences: UnitPreferences; zones: AthleteZones }
): TrainingPlan {
  plan.preferences = update.preferences;
  plan.zones = update.zones;
  plan.meta.updatedAt = new Date().toISOString();
  return plan;
}
