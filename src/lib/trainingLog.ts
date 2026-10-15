/**
 * What actually happened, as opposed to what the plan says: activities
 * recorded on Garmin and the athlete's own feedback per workout. Shared by
 * the server (lib/server/activities.ts, feedback.ts) and the plan view.
 */

/** A recorded (Garmin) activity, trimmed to what the plan view shows. */
export interface RecordedActivity {
  id: number;
  name: string | null;
  sportType: string | null;
  /** Local start, "YYYY-MM-DDTHH:MM:SS" - its date part is the plan day. */
  startLocal: string;
  movingSeconds: number | null;
  distanceMeters: number | null;
  averageHeartrate: number | null;
}

export const FEELINGS = ["great", "good", "ok", "hard", "awful"] as const;
export type Feeling = (typeof FEELINGS)[number];

export const FEELING_LABELS: Record<Feeling, string> = {
  great: "Great",
  good: "Good",
  ok: "OK",
  hard: "Hard",
  awful: "Awful",
};

/** How a workout felt, as the athlete reported it (workout_feedback in db/schema.ts). */
export interface WorkoutFeedback {
  workoutId: string;
  rpe: number | null;
  feeling: Feeling | null;
  pain: boolean;
  painNotes: string | null;
  notes: string | null;
  updatedAt: string;
}
