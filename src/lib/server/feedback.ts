import { all, run } from "../../db/client.js";
import type { Feeling, WorkoutFeedback } from "../trainingLog.js";
import type { WorkoutFeedbackInput } from "./validation.js";

interface FeedbackRow {
  workout_id: string;
  rpe: number | null;
  feeling: Feeling | null;
  pain: number;
  pain_notes: string | null;
  notes: string | null;
  updated_at: string;
}

/** All feedback for one plan, keyed by workout id. */
export function getFeedbackForPlan(
  userId: number,
  planId: string
): Record<string, WorkoutFeedback> {
  const rows = all<FeedbackRow>(
    `SELECT workout_id, rpe, feeling, pain, pain_notes, notes, updated_at
     FROM workout_feedback WHERE user_id = ? AND plan_id = ?`,
    [userId, planId]
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.workout_id,
      {
        workoutId: r.workout_id,
        rpe: r.rpe,
        feeling: r.feeling,
        pain: r.pain === 1,
        painNotes: r.pain_notes,
        notes: r.notes,
        updatedAt: r.updated_at,
      },
    ])
  );
}

export function saveFeedback(
  userId: number,
  planId: string,
  workoutId: string,
  input: WorkoutFeedbackInput
): void {
  run(
    `INSERT INTO workout_feedback (user_id, plan_id, workout_id, rpe, feeling, pain, pain_notes, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, plan_id, workout_id) DO UPDATE SET
       rpe = excluded.rpe, feeling = excluded.feeling, pain = excluded.pain,
       pain_notes = excluded.pain_notes, notes = excluded.notes, updated_at = datetime('now')`,
    [
      userId,
      planId,
      workoutId,
      input.rpe,
      input.feeling,
      input.pain ? 1 : 0,
      input.painNotes,
      input.notes,
    ]
  );
}

export function deleteFeedback(userId: number, planId: string, workoutId: string): void {
  run("DELETE FROM workout_feedback WHERE user_id = ? AND plan_id = ? AND workout_id = ?", [
    userId,
    planId,
    workoutId,
  ]);
}
