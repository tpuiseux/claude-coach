/**
 * A week of the plan against what happened: sessions done and missed,
 * volume, how easy the easy runs were, what the athlete reported, how they
 * recovered - and the signals worth a word with the coach. Computed by the
 * server for every week that has started (lib/server/weekReview.ts), shown
 * under each week's header (WeekCard.svelte).
 */

import type { TrainingWeek, WorkoutType } from "../schema/training-plan.js";
import type { HrZone } from "./settings.js";
import {
  activitySport,
  matchDay,
  type RecordedActivity,
  type WorkoutFeedback,
} from "./trainingLog.js";

/** The daily_wellness columns the review reads. */
export interface WellnessDay {
  date: string;
  sleep_score: number | null;
  resting_hr: number | null;
  hrv_status: string | null;
  training_readiness_score: number | null;
  acwr: number | null;
}

export type ReviewFlagLevel = "warning" | "info";

export interface ReviewFlag {
  level: ReviewFlagLevel;
  text: string;
}

export interface WeekReview {
  weekNumber: number;
  /** The week is still going: misses and totals are so far. */
  inProgress: boolean;
  sessions: { planned: number; done: number };
  missed: string[];
  minutes: { planned: number; actual: number };
  runKm: { planned: number | null; actual: number };
  /** Runs matched to easy/long/recovery workouts. */
  easyRuns: { count: number; pace: number | null; heartrate: number | null } | null;
  feedback: { count: number; averageRpe: number | null; pain: string[] };
  recovery: {
    sleepScore: number | null;
    restingHr: number | null;
    readiness: number | null;
    /** Days with HRV status LOW or UNBALANCED. */
    hrvLowDays: number;
    acwr: number | null;
  } | null;
  flags: ReviewFlag[];
  /** The coach's note from the last check-in on this week. */
  coachNote: { summary: string; focus: string; updatedAt: string } | null;
}

const EASY_TYPES: WorkoutType[] = ["endurance", "recovery", "long"];
const HRV_LOW = ["LOW", "UNBALANCED", "POOR"];

function average(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** The top of the aerobic zone: the high end of zone 2. */
function easyCeiling(zones: HrZone[]): number | null {
  const z2 = zones.find((z) => String(z.zone) === "2");
  return z2?.high ?? null;
}

export function reviewWeek(
  week: TrainingWeek,
  today: string,
  activitiesByDate: Record<string, RecordedActivity[]>,
  feedback: Record<string, WorkoutFeedback>,
  wellness: WellnessDay[],
  hrZones: HrZone[],
  coachNote: WeekReview["coachNote"] = null
): WeekReview {
  const inProgress = today <= week.endDate;
  let planned = 0;
  let done = 0;
  let plannedMinutes = 0;
  let actualSeconds = 0;
  let runMeters = 0;
  const missed: string[] = [];
  const easy: RecordedActivity[] = [];
  const reports: WorkoutFeedback[] = [];

  for (const day of week.days ?? []) {
    const workouts = (day.workouts ?? []).filter((w) => w.sport !== "rest");
    const recorded = activitiesByDate[day.date] ?? [];
    const match = matchDay(day.workouts ?? [], recorded);

    for (const a of recorded) {
      actualSeconds += a.movingSeconds ?? 0;
      if (activitySport(a.sportType) === "run") runMeters += a.distanceMeters ?? 0;
    }
    for (const w of workouts) {
      planned++;
      plannedMinutes += w.durationMinutes ?? 0;
      const matched = match.byWorkout[w.id] ?? [];
      if (matched.length > 0 || w.completed) done++;
      else if (day.date < today) missed.push(w.name);
      if (w.sport === "run" && EASY_TYPES.includes(w.type)) easy.push(...matched);
      if (feedback[w.id]) reports.push(feedback[w.id]);
    }
  }

  const easySeconds = easy.reduce((s, a) => s + (a.movingSeconds ?? 0), 0);
  const easyMeters = easy.reduce((s, a) => s + (a.distanceMeters ?? 0), 0);
  const easyRuns = easy.length
    ? {
        count: easy.length,
        pace: easyMeters > 0 ? (easySeconds / easyMeters) * 1000 : null,
        // Time-weighted: a long run counts for more than a 30-minute jog.
        heartrate:
          easySeconds > 0 && easy.every((a) => a.averageHeartrate)
            ? easy.reduce((s, a) => s + a.averageHeartrate! * (a.movingSeconds ?? 0), 0) /
              easySeconds
            : average(easy.map((a) => a.averageHeartrate)),
      }
    : null;

  const days = wellness.filter((d) => d.date >= week.startDate && d.date <= week.endDate);
  const lastAcwr = [...days].reverse().find((d) => d.acwr !== null)?.acwr ?? null;
  const recovery = days.length
    ? {
        sleepScore: average(days.map((d) => d.sleep_score)),
        restingHr: average(days.map((d) => d.resting_hr)),
        readiness: average(days.map((d) => d.training_readiness_score)),
        hrvLowDays: days.filter((d) => d.hrv_status && HRV_LOW.includes(d.hrv_status.toUpperCase()))
          .length,
        acwr: lastAcwr,
      }
    : null;

  const pain = reports.filter((r) => r.pain).map((r) => r.painNotes?.trim() || "pain reported");
  const flags: ReviewFlag[] = [];
  if (missed.length) {
    flags.push({ level: "info", text: `${missed.length} missed` });
  }
  const ceiling = easyCeiling(hrZones);
  if (easyRuns?.heartrate && ceiling && easyRuns.heartrate > ceiling) {
    flags.push({
      level: "warning",
      text: `Easy runs above zone 2 (${Math.round(easyRuns.heartrate)} bpm)`,
    });
  }
  if (pain.length) {
    flags.push({
      level: "warning",
      text: pain.length === 1 ? "Pain reported" : `Pain reported ×${pain.length}`,
    });
  }
  if (recovery?.acwr && recovery.acwr > 1.5) {
    flags.push({ level: "warning", text: `Load ramping fast (ACWR ${recovery.acwr.toFixed(1)})` });
  }
  if (recovery && recovery.hrvLowDays >= 3) {
    flags.push({ level: "warning", text: `HRV low ${recovery.hrvLowDays} days` });
  }
  if (recovery?.sleepScore && recovery.sleepScore < 60) {
    flags.push({ level: "warning", text: `Poor sleep (score ${Math.round(recovery.sleepScore)})` });
  }
  if (recovery?.readiness && recovery.readiness < 40) {
    flags.push({ level: "warning", text: `Low readiness (${Math.round(recovery.readiness)})` });
  }

  return {
    weekNumber: week.weekNumber,
    inProgress,
    sessions: { planned, done },
    missed,
    minutes: { planned: plannedMinutes, actual: Math.round(actualSeconds / 60) },
    runKm: {
      planned: week.summary?.bySport?.run?.km ?? null,
      actual: Math.round(runMeters / 100) / 10,
    },
    easyRuns,
    feedback: { count: reports.length, averageRpe: average(reports.map((r) => r.rpe)), pain },
    recovery,
    flags,
    coachNote,
  };
}
