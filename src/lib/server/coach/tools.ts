import type Anthropic from "@anthropic-ai/sdk";
import { all } from "../../../db/client.js";
import type { TrainingPlan, TrainingWeek } from "../../../schema/training-plan.js";
import { aerobicDecoupling, timeInZones } from "../../activityAnalysis.js";
import type { CoachProposal } from "../../coach.js";
import { deriveSettingsFromPlan } from "../../settings.js";
import { matchDay } from "../../trainingLog.js";
import { getActivitiesByDate } from "../activities.js";
import { getActivityDetails } from "../activityDetails.js";
import { getFeedbackForPlan } from "../feedback.js";
import { loadPlanForUser } from "../plans.js";
import { getRacePrediction } from "../racePrediction.js";
import { isIsoDate, ValidationError } from "../validation.js";
import { getWeekReviews, saveWeekNote } from "../weekReview.js";
import { applyPlanChanges, parsePlanChanges } from "./changes.js";
import { createProposal } from "./store.js";

/**
 * What the coach can look at and do: read the plan, the athlete's recorded
 * sessions, their feedback, recovery data and race prediction, and propose
 * plan changes. It never changes the plan itself - a proposal waits for the
 * athlete to apply it.
 */

type Tool = Anthropic.Beta.Messages.BetaTool;

const noInput = { type: "object" as const, properties: {}, additionalProperties: false };

const dateRange = {
  type: "object" as const,
  properties: {
    start: { type: "string", description: "First day, YYYY-MM-DD" },
    end: { type: "string", description: "Last day, YYYY-MM-DD (inclusive)" },
  },
  required: ["start", "end"],
  additionalProperties: false,
};

const workoutFields = {
  type: "object",
  description:
    "Workout fields. sport: swim|bike|run|strength|brick|race|rest. type: rest|recovery|endurance|tempo|threshold|intervals|vo2max|sprint|race|brick|technique|openwater|hills|long. Also name, description, durationMinutes (whole session, warm-up and cool-down included), distanceMeters, primaryZone, humanReadable (the session as the athlete reads it - its parts add up to durationMinutes), rpe (1-10), notes, structure (steps for the Garmin export, same shape as the plan's existing workouts: {warmup?, main, cooldown?}; each step {type: warmup|work|recovery|rest|cooldown, name?, duration: {unit, value}, intensity: {unit: pace_zone|hr_zone|rpe|percent_lthr|percent_ftp|css_offset, value, valueLow?, valueHigh?, description?}}; repeats as {type: 'interval_set', repeats, steps}). Running pace targets use unit pace_zone with valueLow/valueHigh in seconds per km.",
};

export const COACH_TOOLS: Tool[] = [
  {
    name: "get_plan_overview",
    description:
      "The plan at a glance: event and dates, the athlete's assessment and constraints, zones, phases, race strategy, and one line per week (dates, phase, focus, target hours, how many sessions are done). Start here when you don't know the plan yet.",
    input_schema: noInput,
  },
  {
    name: "get_week",
    description:
      "One week of the plan in full: every workout (id, content, structure, done or not), what was actually recorded on Garmin each day and which workout it matched, the athlete's feedback (RPE, feeling, pain), the app's review of the week once it has started (sessions done and missed, volume, easy-run pace and heart rate, recovery averages, warning flags) and your note from the last check-in on it. Give a week number or any date in the week.",
    input_schema: {
      type: "object",
      properties: {
        weekNumber: { type: "integer", description: "Week number, 1-based" },
        date: { type: "string", description: "Any date in the week, YYYY-MM-DD" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_activities",
    description:
      "Recorded Garmin activities between two dates, any sport: distance, time, pace, heart rate, elevation, Garmin training effect and load. Use for training outside the plan's weeks or to scan a period quickly.",
    input_schema: dateRange,
  },
  {
    name: "get_activity_details",
    description:
      "One recorded activity in depth: laps (pace, heart rate, cadence each), aerobic decoupling (pace vs heart rate drift between halves), and time in each heart-rate zone. Use to judge how a session was actually run.",
    input_schema: {
      type: "object",
      properties: { activityId: { type: "integer" } },
      required: ["activityId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_recovery",
    description:
      "Daily recovery data from Garmin between two dates: sleep (score, duration), resting heart rate, HRV (last night, weekly average, status), stress, body battery, training readiness, acute and chronic training load, ACWR, training status, VO2max.",
    input_schema: dateRange,
  },
  {
    name: "get_race_prediction",
    description:
      "The app's predicted finish time for the race, the estimates it averages (best recent effort, pace at race heart rate, training volume, Garmin VO2max) and how it moved week by week.",
    input_schema: noInput,
  },
  {
    name: "save_week_review",
    description:
      "Save your note on a week at the end of a weekly check-in: shown to the athlete under that week, and returned by get_week so the next check-in can follow up. Replaces any earlier note on the same week. Write it in the athlete's language.",
    input_schema: {
      type: "object",
      properties: {
        weekNumber: { type: "integer" },
        summary: {
          type: "string",
          description:
            "2-4 sentences: how the week went against the plan, what the athlete said, recovery if it mattered, adjustments made or declined",
        },
        focus: { type: "string", description: "The one or two things to focus on next week" },
      },
      required: ["weekNumber", "summary", "focus"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_plan_changes",
    description:
      "Propose changes to the plan. The athlete sees them as a card and applies or rejects them - nothing changes until they apply, and you'll be told what they did with their next message. Group related changes into one proposal. Changes apply in order; a proposal applies whole or not at all. Completed workouts can't be changed. When you add a session or change what one is (sport, type, length, content), give its humanReadable and its structure (the steps the athlete's watch follows, the repeats as an interval_set) - without one, the watch shows a single long block. Interval, tempo, threshold, VO2max, sprint and hill sessions are refused without a structure.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "One line for the card, in the athlete's language, e.g. 'Lighter week after the hamstring flare-up'",
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["move", "edit", "add", "delete"] },
              workoutId: { type: "string", description: "move, edit, delete: the workout's id" },
              date: { type: "string", description: "move: the new date; add: the day, YYYY-MM-DD" },
              updates: {
                ...workoutFields,
                description: `edit: only the fields that change. ${workoutFields.description}`,
              },
              workout: {
                ...workoutFields,
                description: `add: the new workout (sport, type and name required). ${workoutFields.description}`,
              },
              reason: {
                type: "string",
                description: "Why, in a few words, in the athlete's language",
              },
            },
            required: ["op", "reason"],
          },
        },
      },
      required: ["summary", "changes"],
    },
  },
];

/** Shown in the chat while the coach is looking something up. */
export const TOOL_LABELS: Record<string, string> = {
  get_plan_overview: "Reading the plan",
  get_week: "Reading the week",
  get_activities: "Looking at your activities",
  get_activity_details: "Analysing a session",
  get_recovery: "Checking your recovery",
  get_race_prediction: "Checking the race prediction",
  save_week_review: "Saving the week's notes",
  propose_plan_changes: "Preparing changes",
};

export interface ToolContext {
  userId: number;
  planId: string;
  conversationId: number;
  /** The coach message the tool calls came in. */
  messageId: number;
  /** Called when a proposal is made, so the chat can show it right away. */
  onProposal: (proposal: CoachProposal) => void;
}

function round(value: number | null | undefined, digits = 0): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** "4:52" per km for a speed in m/s. */
function pace(speed: number | null | undefined): string | null {
  if (!speed || speed <= 0) return null;
  const s = Math.round(1000 / speed);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

function requirePlan(ctx: ToolContext): TrainingPlan {
  const plan = loadPlanForUser(ctx.planId, ctx.userId);
  if (!plan) throw new ValidationError("The plan no longer exists");
  return plan;
}

function planOverview(plan: TrainingPlan) {
  const { weeks, ...rest } = plan;
  return {
    ...rest,
    weeks: (weeks ?? []).map((w) => {
      const workouts = (w.days ?? [])
        .flatMap((d) => d.workouts ?? [])
        .filter((x) => x.sport !== "rest");
      return {
        weekNumber: w.weekNumber,
        startDate: w.startDate,
        endDate: w.endDate,
        phase: w.phase,
        focus: w.focus,
        targetHours: w.targetHours,
        isRecoveryWeek: w.isRecoveryWeek,
        sessions: workouts.length,
        completed: workouts.filter((x) => x.completed).length,
      };
    }),
  };
}

function findWeek(plan: TrainingPlan, input: Record<string, unknown>): TrainingWeek {
  const weeks = plan.weeks ?? [];
  let week: TrainingWeek | undefined;
  if (typeof input.weekNumber === "number") {
    week = weeks.find((w) => w.weekNumber === input.weekNumber);
  } else if (isIsoDate(input.date)) {
    const date = input.date;
    week = weeks.find((w) => w.startDate <= date && date <= w.endDate);
  } else {
    throw new ValidationError("Give weekNumber or date");
  }
  if (!week) throw new ValidationError("No such week in this plan");
  return week;
}

function weekDetail(ctx: ToolContext, plan: TrainingPlan, week: TrainingWeek) {
  const activities = getActivitiesByDate(ctx.userId, week.startDate, week.endDate);
  const feedback = getFeedbackForPlan(ctx.userId, ctx.planId);
  const review =
    getWeekReviews(ctx.userId, ctx.planId, { ...plan, weeks: [week] }, activities, feedback)[
      week.weekNumber
    ] ?? null;
  return {
    ...week,
    review,
    days: (week.days ?? []).map((day) => {
      const recorded = activities[day.date] ?? [];
      const match = matchDay(day.workouts ?? [], recorded);
      return {
        date: day.date,
        dayOfWeek: day.dayOfWeek,
        workouts: (day.workouts ?? []).map((w) => ({
          ...w,
          feedback: feedback[w.id] ?? null,
          recordedActivityIds: (match.byWorkout[w.id] ?? []).map((a) => a.id),
        })),
        recorded: recorded.map((a) => ({
          id: a.id,
          name: a.name,
          sportType: a.sportType,
          start: a.startLocal,
          distanceKm: round((a.distanceMeters ?? 0) / 1000, 2),
          minutes: round((a.movingSeconds ?? 0) / 60, 1),
          pace:
            a.movingSeconds && a.distanceMeters ? pace(a.distanceMeters / a.movingSeconds) : null,
          averageHeartrate: round(a.averageHeartrate),
          plannedWorkoutId:
            Object.entries(match.byWorkout).find(([, list]) =>
              list.some((x) => x.id === a.id)
            )?.[0] ?? null,
        })),
      };
    }),
  };
}

export function checkRange(input: Record<string, unknown>): { start: string; end: string } {
  const { start, end } = input;
  if (!isIsoDate(start) || !isIsoDate(end))
    throw new ValidationError("start and end must be YYYY-MM-DD");
  if (end < start) throw new ValidationError("end is before start");
  return { start, end };
}

function activitiesBetween(ctx: ToolContext, input: Record<string, unknown>) {
  const { start, end } = checkRange(input);
  return listActivities(ctx.userId, start, end);
}

/** The user's recorded activities between two dates (inclusive), any sport. */
export function listActivities(userId: number, start: string, end: string) {
  const rows = all<{
    id: number;
    name: string | null;
    sport_type: string | null;
    start: string;
    distance: number | null;
    moving_time: number | null;
    average_speed: number | null;
    average_heartrate: number | null;
    max_heartrate: number | null;
    total_elevation_gain: number | null;
    raw_json: string | null;
  }>(
    `SELECT id, name, sport_type, COALESCE(start_date_local, start_date) AS start, distance,
            moving_time, average_speed, average_heartrate, max_heartrate, total_elevation_gain, raw_json
     FROM activities
     WHERE user_id = ? AND COALESCE(start_date_local, start_date) >= ?
       AND COALESCE(start_date_local, start_date) < date(?, '+1 day')
     ORDER BY start`,
    [userId, start, end]
  );
  return rows.map((r) => {
    let raw: Record<string, unknown> = {};
    try {
      raw = r.raw_json ? JSON.parse(r.raw_json) : {};
    } catch {
      // The columns are enough.
    }
    return {
      id: r.id,
      name: r.name,
      sportType: r.sport_type,
      start: r.start,
      distanceKm: round((r.distance ?? 0) / 1000, 2),
      minutes: round((r.moving_time ?? 0) / 60, 1),
      pace: r.sport_type?.includes("Run") ? pace(r.average_speed) : null,
      averageHeartrate: round(r.average_heartrate),
      maxHeartrate: round(r.max_heartrate),
      elevationGainM: round(r.total_elevation_gain),
      aerobicEffect: raw.aerobicTrainingEffect ?? null,
      anaerobicEffect: raw.anaerobicTrainingEffect ?? null,
      trainingLoad: round(raw.activityTrainingLoad as number | undefined),
    };
  });
}

async function activityDetail(
  ctx: ToolContext,
  plan: TrainingPlan,
  input: Record<string, unknown>
) {
  const id = input.activityId;
  if (typeof id !== "number") throw new ValidationError("activityId must be a number");
  const result = await getActivityDetails(ctx.userId, id);
  if (!result.ok) throw new ValidationError(result.message);
  const { stats, series, laps, detailsError } = result.analysis;
  const zones = deriveSettingsFromPlan(plan).run.hrZones;
  const time = series.time ?? [];
  const inZones =
    series.heartrate && zones.length ? timeInZones(time, series.heartrate, zones) : null;
  return {
    stats: {
      ...stats,
      averagePace: pace(stats.averageSpeed),
      distanceKm: round((stats.distanceMeters ?? 0) / 1000, 2),
    },
    aerobicDecouplingPercent:
      series.speed && series.heartrate
        ? round(aerobicDecoupling(time, series.speed, series.heartrate), 1)
        : null,
    minutesInHeartRateZones: inZones
      ? zones.map((z, i) => ({ zone: z.zone, name: z.name, minutes: round(inZones[i] / 60, 1) }))
      : null,
    laps: laps.map((l, i) => ({
      lap: i + 1,
      distanceKm: round((l.distance ?? 0) / 1000, 2),
      minutes: round((l.movingDuration ?? l.duration ?? 0) / 60, 2),
      pace: pace(l.averageSpeed),
      averageHR: round(l.averageHR),
      maxHR: round(l.maxHR),
      cadence: round(l.averageCadence),
      intensity: l.intensityType ?? null,
    })),
    note: detailsError ?? undefined,
  };
}

function recovery(ctx: ToolContext, input: Record<string, unknown>) {
  const { start, end } = checkRange(input);
  return all(
    `SELECT date, sleep_score, ROUND(sleep_seconds / 3600.0, 1) AS sleep_hours, resting_hr,
            hrv_last_night_avg, hrv_weekly_avg, hrv_status, avg_stress, body_battery_high,
            body_battery_low, training_readiness_score, training_readiness_level,
            acute_training_load, chronic_training_load, acwr, acwr_status, training_status, vo2max
     FROM daily_wellness WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
    [ctx.userId, start, end]
  );
}

function propose(ctx: ToolContext, input: Record<string, unknown>) {
  if (typeof input.summary !== "string" || !input.summary.trim()) {
    throw new ValidationError("summary is required");
  }
  const changes = parsePlanChanges(input.changes);
  // Try them on a copy: a proposal the plan can't take goes back to the coach.
  const plan = requirePlan(ctx);
  const preview = applyPlanChanges(structuredClone(plan), changes);
  const proposal = createProposal(
    ctx.conversationId,
    ctx.messageId,
    ctx.userId,
    ctx.planId,
    input.summary.trim(),
    changes,
    preview
  );
  ctx.onProposal(proposal);
  return {
    proposalId: proposal.id,
    status: "shown to the athlete - not applied until they accept it",
  };
}

/** Runs one tool call. Returns its result as JSON text; throws on bad input. */
export async function runCoachTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown
): Promise<string> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
    string,
    unknown
  >;
  let result: unknown;
  switch (name) {
    case "get_plan_overview":
      result = planOverview(requirePlan(ctx));
      break;
    case "get_week": {
      const plan = requirePlan(ctx);
      result = weekDetail(ctx, plan, findWeek(plan, input));
      break;
    }
    case "get_activities":
      result = activitiesBetween(ctx, input);
      break;
    case "get_activity_details":
      result = await activityDetail(ctx, requirePlan(ctx), input);
      break;
    case "get_recovery":
      result = recovery(ctx, input);
      break;
    case "get_race_prediction":
      result = getRacePrediction(ctx.userId, requirePlan(ctx)) ?? {
        note: "No prediction: not a running race, or no runs synced yet",
      };
      break;
    case "save_week_review": {
      const { weekNumber, summary, focus } = input;
      const plan = requirePlan(ctx);
      if (typeof weekNumber !== "number" || !plan.weeks?.some((w) => w.weekNumber === weekNumber)) {
        throw new ValidationError("No such week in this plan");
      }
      if (typeof summary !== "string" || !summary.trim() || typeof focus !== "string") {
        throw new ValidationError("summary and focus are required");
      }
      saveWeekNote(ctx.userId, ctx.planId, weekNumber, summary.trim(), focus.trim());
      result = { saved: true };
      break;
    }
    case "propose_plan_changes":
      result = propose(ctx, input);
      break;
    default:
      throw new ValidationError(`Unknown tool ${name}`);
  }
  return JSON.stringify(result);
}
