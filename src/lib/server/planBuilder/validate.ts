import type {
  AthleteZones,
  IntervalSet,
  RaceStrategy,
  Sport,
  StructuredWorkout,
  TrainingPhase,
  TrainingWeek,
  Workout,
  WorkoutStep,
} from "../../../schema/training-plan.js";
import type { PlanAssessment, PlanForm } from "../../planDraft.js";
import { parseFields, requireSteps } from "../coach/changes.js";
import { ValidationError } from "../validation.js";
import { dayOfWeek, type WeekFrame } from "./form.js";

/**
 * Checks on what the coach writes while building a plan. Anything that
 * would break the app (wrong dates, unknown fields, zones it can't read) is
 * refused and goes back to the coach to fix; things worth a second look
 * (a session on a day the athlete can't train, a week far off its target
 * hours) are accepted and reported back to it.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function req<T>(ok: boolean, value: T, message: string): T {
  if (!ok) throw new ValidationError(message);
  return value;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

function parseZones(input: unknown): AthleteZones {
  req(isPlainObject(input) && isPlainObject(input.run), null, "zones.run is required");
  const run = (input as { run: Record<string, unknown> }).run;
  const hr = run.hr as Record<string, unknown> | undefined;
  req(
    isPlainObject(hr) && isNum(hr.lthr) && Array.isArray(hr.zones) && hr.zones.length >= 3,
    null,
    "zones.run.hr needs lthr and its zones"
  );
  for (const [i, z] of (hr!.zones as unknown[]).entries()) {
    req(
      isPlainObject(z) &&
        (isNum(z.zone) || typeof z.zone === "string") &&
        typeof z.name === "string" &&
        isNum(z.hrLow) &&
        isNum(z.hrHigh) &&
        isNum(z.percentLow) &&
        isNum(z.percentHigh),
      null,
      `zones.run.hr.zones[${i}] needs zone, name, percentLow, percentHigh, hrLow, hrHigh`
    );
  }
  const pace = run.pace as Record<string, unknown> | undefined;
  req(
    isPlainObject(pace) &&
      typeof pace.thresholdPace === "string" &&
      isNum(pace.thresholdPaceSeconds) &&
      Array.isArray(pace.zones) &&
      pace.zones.length >= 3,
    null,
    "zones.run.pace needs thresholdPace, thresholdPaceSeconds and its zones"
  );
  for (const [i, z] of (pace!.zones as unknown[]).entries()) {
    req(
      isPlainObject(z) &&
        typeof z.zone === "string" &&
        typeof z.name === "string" &&
        typeof z.pace === "string" &&
        isNum(z.paceSeconds),
      null,
      `zones.run.pace.zones[${i}] needs zone, name, pace, paceSeconds (and low/high bounds)`
    );
  }
  return input as AthleteZones;
}

function parsePhases(input: unknown, totalWeeks: number): TrainingPhase[] {
  req(Array.isArray(input) && input.length > 0, null, "phases is required");
  const phases = input as TrainingPhase[];
  let next = 1;
  for (const [i, p] of phases.entries()) {
    req(
      isPlainObject(p) &&
        typeof p.name === "string" &&
        typeof p.focus === "string" &&
        isNum(p.startWeek) &&
        isNum(p.endWeek),
      null,
      `phases[${i}] needs name, startWeek, endWeek, focus`
    );
    req(
      p.startWeek === next && p.endWeek >= p.startWeek,
      null,
      `phases[${i}] should start at week ${next}`
    );
    next = p.endWeek + 1;
    p.weeklyHoursRange ??= { low: 0, high: 0 };
    p.keyWorkouts ??= [];
    p.physiologicalGoals ??= [];
  }
  req(next === totalWeeks + 1, null, `phases must cover weeks 1 to ${totalWeeks}`);
  return phases;
}

export function parseAssessment(input: unknown, totalWeeks: number): PlanAssessment {
  req(isPlainObject(input), null, "assessment input must be an object");
  const i = input as Record<string, unknown>;
  const message = req(
    typeof i.message === "string" && i.message.trim() !== "",
    i.message as string,
    "message is required"
  );
  const goalTime = req(
    typeof i.goalTime === "string" && /\d:\d{2}/.test(i.goalTime),
    i.goalTime as string,
    "goalTime is required, e.g. 3:12:00"
  );
  const a = i.assessment as Record<string, unknown>;
  req(
    isPlainObject(a) && isPlainObject(a.foundation) && isPlainObject(a.currentForm),
    null,
    "assessment needs foundation and currentForm (AthleteAssessment)"
  );
  for (const key of ["strengths", "limiters", "constraints"]) {
    if (!Array.isArray(a[key])) a[key] = [];
  }
  return {
    message: message.trim(),
    goalTime,
    assessment: a as unknown as PlanAssessment["assessment"],
    zones: parseZones(i.zones),
    phases: parsePhases(i.phases, totalWeeks),
  };
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

const DOW_LABELS: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const TIME_UNITS: Record<string, number> = { seconds: 1 / 60, minutes: 1, hours: 60 };

/** Minutes a structure adds up to, or null when part of it is a distance. */
export function structureMinutes(s: StructuredWorkout): number | null {
  let total = 0;
  const add = (step: WorkoutStep, times = 1): boolean => {
    const f = TIME_UNITS[step.duration.unit];
    if (f === undefined) return false;
    total += step.duration.value * f * times;
    return true;
  };
  const items: (WorkoutStep | IntervalSet)[] = [
    ...(s.warmup ?? []),
    ...s.main,
    ...(s.cooldown ?? []),
  ];
  for (const item of items) {
    if ("repeats" in item) {
      for (const step of item.steps) if (!add(step, item.repeats)) return null;
    } else if (!add(item)) {
      return null;
    }
  }
  return total;
}

export interface ParsedWeek {
  week: TrainingWeek;
  /** Accepted, but worth the coach's second look. */
  notes: string[];
}

export function parseWeek(
  input: unknown,
  frame: WeekFrame,
  form: PlanForm,
  phases: TrainingPhase[]
): ParsedWeek {
  req(isPlainObject(input), null, "week must be an object");
  const w = input as Record<string, unknown>;
  req(w.weekNumber === frame.weekNumber, null, `weekNumber must be ${frame.weekNumber}`);
  req(
    Array.isArray(w.days) && w.days.length === 7,
    null,
    `days must list the 7 days ${frame.startDate} to ${frame.endDate}`
  );
  const phase = phases.find(
    (p) => p.startWeek <= frame.weekNumber && frame.weekNumber <= p.endWeek
  );
  const notes: string[] = [];
  const usedIds = new Set<string>();

  const days = (w.days as unknown[]).map((rawDay, d) => {
    const date = frame.dates[d];
    req(
      isPlainObject(rawDay) && (rawDay as Record<string, unknown>).date === date,
      null,
      `days[${d}].date must be ${date}`
    );
    const rawWorkouts = (rawDay as Record<string, unknown>).workouts ?? [];
    req(Array.isArray(rawWorkouts), null, `days[${d}].workouts must be an array`);
    const dow = dayOfWeek(date);
    const workouts = (rawWorkouts as unknown[]).map((raw, k): Workout => {
      let fields;
      try {
        fields = parseFields(raw, true);
      } catch (err) {
        throw new ValidationError(`${date} workout ${k + 1}: ${(err as Error).message}`);
      }
      try {
        requireSteps(fields as Workout);
      } catch (err) {
        throw new ValidationError(`${date}: ${(err as Error).message}`);
      }
      const minutes = fields.structure ? structureMinutes(fields.structure) : null;
      if (
        minutes !== null &&
        fields.durationMinutes &&
        Math.abs(minutes - fields.durationMinutes) > Math.max(5, fields.durationMinutes * 0.1)
      ) {
        throw new ValidationError(
          `${date} "${fields.name}": its structure adds up to ${Math.round(minutes)} min but durationMinutes is ${fields.durationMinutes} - make them match`
        );
      }
      if (fields.sport !== "rest" && !form.availableDays.includes(dow)) {
        notes.push(`${date} (${DOW_LABELS[dow]}) isn't one of the athlete's available days`);
      }
      let id = `w${frame.weekNumber}-${dow.slice(0, 3)}-${fields.sport}`;
      for (let n = 2; usedIds.has(id); n++)
        id = `w${frame.weekNumber}-${dow.slice(0, 3)}-${fields.sport}${n}`;
      usedIds.add(id);
      return { description: "", ...fields, id, completed: false } as Workout;
    });
    return { date, dayOfWeek: DOW_LABELS[dow], workouts };
  });

  const all = days.flatMap((d) => d.workouts).filter((x) => x.sport !== "rest");
  const bySport: TrainingWeek["summary"]["bySport"] = {};
  let totalMinutes = 0;
  for (const x of all) {
    const s = (bySport[x.sport as Sport] ??= { sessions: 0, hours: 0, km: 0 });
    s.sessions++;
    s.hours += (x.durationMinutes ?? 0) / 60;
    s.km = (s.km ?? 0) + (x.distanceMeters ?? 0) / 1000;
    totalMinutes += x.durationMinutes ?? 0;
  }
  for (const s of Object.values(bySport)) {
    s!.hours = Math.round(s!.hours * 10) / 10;
    s!.km = Math.round((s!.km ?? 0) * 10) / 10;
    if (!s!.km) delete s!.km;
  }
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const targetHours = isNum(w.targetHours) ? w.targetHours : totalHours;
  if (targetHours > 0 && Math.abs(totalHours - targetHours) / targetHours > 0.2) {
    notes.push(`sessions add up to ${totalHours} h against a target of ${targetHours} h`);
  }
  const runs = all.filter((x) => x.sport === "run").length;
  if (runs > form.runsPerWeek)
    notes.push(`${runs} runs, more than the athlete's ${form.runsPerWeek} per week`);

  return {
    week: {
      weekNumber: frame.weekNumber,
      startDate: frame.startDate,
      endDate: frame.endDate,
      phase: typeof w.phase === "string" ? w.phase : (phase?.name ?? ""),
      focus: typeof w.focus === "string" ? w.focus : "",
      targetHours,
      isRecoveryWeek: w.isRecoveryWeek === true,
      days,
      summary: { totalHours, bySport },
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Race strategy
// ---------------------------------------------------------------------------

export function parseRaceStrategy(
  input: unknown,
  form: PlanForm,
  distanceKm: number
): RaceStrategy {
  req(isPlainObject(input), null, "raceStrategy must be an object");
  const r = input as Record<string, unknown>;
  const pacing = r.pacing as Record<string, unknown>;
  req(
    isPlainObject(pacing) && isPlainObject(pacing.run),
    null,
    "raceStrategy.pacing.run is required (targetPace, targetHR, notes)"
  );
  req(isPlainObject(r.nutrition), null, "raceStrategy.nutrition is required");
  req(isPlainObject(r.taper), null, "raceStrategy.taper is required");
  return {
    ...(r as unknown as RaceStrategy),
    event: {
      name: form.raceName,
      date: form.raceDate,
      type:
        isPlainObject(r.event) && typeof r.event.type === "string" ? r.event.type : form.distance,
      distances: { run: distanceKm },
    },
    raceDay: isPlainObject(r.raceDay) ? (r.raceDay as RaceStrategy["raceDay"]) : {},
  };
}
