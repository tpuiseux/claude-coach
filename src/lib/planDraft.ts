/**
 * A training plan being made online: the athlete's answers to the "Create a
 * plan" form, the coach's assessment for them to confirm, then the plan as
 * the coach writes it week by week. Shared by the server
 * (lib/server/planBuilder/) and the pages under routes/plans/new.
 */

import type {
  AthleteAssessment,
  AthleteZones,
  TrainingPhase,
  TrainingWeek,
} from "../schema/training-plan.js";

export const RACE_DISTANCES = {
  "5k": { label: "5 km", km: 5 },
  "10k": { label: "10 km", km: 10 },
  half: { label: "Half marathon", km: 21.0975 },
  marathon: { label: "Marathon", km: 42.195 },
} as const;

export type RaceDistanceKey = keyof typeof RACE_DISTANCES | "other";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface PlanForm {
  raceName: string;
  raceDate: string;
  distance: RaceDistanceKey;
  /** Only for distance "other". */
  distanceKm: number | null;
  /** "trail" adds elevation to think about. */
  terrain: "road" | "trail";
  elevationGainM: number | null;
  /** "h:mm:ss", or empty: the coach suggests one. */
  goalTime: string;
  /** Monday of the first week. */
  startDate: string;
  availableDays: Weekday[];
  longRunDay: Weekday;
  runsPerWeek: number;
  currentWeeklyKm: number;
  longestRecentRunKm: number;
  yearsRunning: number;
  recentRaces: string;
  maxHr: number | null;
  restingHr: number | null;
  injuries: string;
  otherSports: string;
  strength: boolean;
  units: "kilometers" | "miles";
  language: "en" | "fr";
  notes: string;
}

/** What the coach makes of the athlete before writing anything. */
export interface PlanAssessment {
  /** For the athlete: their level, the goal, the plan's outline - in their language. */
  message: string;
  goalTime: string;
  assessment: AthleteAssessment;
  zones: AthleteZones;
  phases: TrainingPhase[];
}

export type DraftStatus =
  | "assessing"
  | "awaiting_confirmation"
  | "generating"
  | "ready"
  | "failed"
  | "adopted";

export interface DraftView {
  id: number;
  status: DraftStatus;
  form: PlanForm;
  assessment: PlanAssessment | null;
  totalWeeks: number;
  /** Weeks written so far (all of them once ready). */
  weeks: TrainingWeek[];
  error: string | null;
  /** The plan's id once adopted. */
  planId: string | null;
  /** The coach is working on it right now. */
  running: boolean;
}
