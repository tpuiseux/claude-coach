/**
 * What actually happened, as opposed to what the plan says: activities
 * recorded on Garmin and the athlete's own feedback per workout. Shared by
 * the server (lib/server/activities.ts, feedback.ts, autoComplete.ts) and
 * the plan view.
 */

import type { Sport, Workout } from "../schema/training-plan.js";

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

// Recorded activities use Strava-style sport types (see SPORT_TYPE_MAP in
// garmin-bridge/sync_activities.py); the plan uses its own Sport values.
const ACTIVITY_SPORTS: Record<string, Sport> = {
  Run: "run",
  TrailRun: "run",
  VirtualRun: "run",
  Ride: "bike",
  GravelRide: "bike",
  MountainBikeRide: "bike",
  VirtualRide: "bike",
  Swim: "swim",
  WeightTraining: "strength",
};

export function activitySport(sportType: string | null): Sport | null {
  return (sportType && ACTIVITY_SPORTS[sportType]) || null;
}

/** Which recorded sports can count as a planned workout of this sport. A
 * brick is a bike then a run; a race is whichever discipline it's in. Rest
 * days never match - anything recorded on one is unplanned. */
const MATCHING_SPORTS: Partial<Record<Sport, Sport[]>> = {
  run: ["run"],
  bike: ["bike"],
  swim: ["swim"],
  strength: ["strength"],
  brick: ["bike", "run"],
  race: ["run", "bike", "swim"],
};

export interface DayMatch {
  /** Activities attributed to each planned workout, by workout id. */
  byWorkout: Record<string, RecordedActivity[]>;
  /** Activities that don't correspond to anything planned that day. */
  unplanned: RecordedActivity[];
}

/**
 * Pairs one day's recorded activities with its planned workouts, by sport
 * and in order: the day's first run goes to its first planned run, and so
 * on. Each workout takes one activity - except a brick, which takes one
 * per discipline (its bike and its run).
 *
 * Fallback for sports the plan has no type for: an activity whose sport
 * appears in a free workout's name goes to it - Garmin "Badminton" to a
 * planned "Badminton (Cross-Training)", which plans file under rest.
 * Whatever's left over (an extra run, a ride on a rest day, a sport the
 * plan doesn't mention that day) is unplanned.
 *
 * Matching is by sport only, not content: easy kilometres recorded in
 * place of a planned interval session still count as that session - the
 * difference shows in the recorded numbers, not here.
 */
export function matchDay(workouts: Workout[], activities: RecordedActivity[]): DayMatch {
  const byWorkout: Record<string, RecordedActivity[]> = {};
  const unplanned: RecordedActivity[] = [];
  const sorted = [...activities].sort((a, b) => a.startLocal.localeCompare(b.startLocal));

  for (const activity of sorted) {
    const sport = activitySport(activity.sportType);
    const target = sport
      ? workouts.find((w) => {
          if (!MATCHING_SPORTS[w.sport]?.includes(sport)) return false;
          const taken = byWorkout[w.id] ?? [];
          if (w.sport === "brick") {
            return !taken.some((a) => activitySport(a.sportType) === sport);
          }
          return taken.length === 0;
        })
      : undefined;

    const named = target ?? workoutNamingSport(workouts, byWorkout, activity.sportType);
    if (named) {
      (byWorkout[named.id] ??= []).push(activity);
    } else {
      unplanned.push(activity);
    }
  }
  return { byWorkout, unplanned };
}

function workoutNamingSport(
  workouts: Workout[],
  taken: Record<string, RecordedActivity[]>,
  sportType: string | null
): Workout | undefined {
  // Short or missing types ("Run" is already matched by sport) would match
  // too loosely inside free-text names.
  if (!sportType || sportType.length < 4) return undefined;
  const needle = sportType.toLowerCase();
  return workouts.find((w) => !taken[w.id]?.length && w.name.toLowerCase().includes(needle));
}
