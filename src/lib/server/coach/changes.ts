import { randomUUID } from "crypto";
import type {
  DurationUnit,
  IntensityUnit,
  StepType,
  StructuredWorkout,
  TrainingPlan,
  Workout,
  WorkoutStep,
  IntervalSet,
} from "../../../schema/training-plan.js";
import type {
  ChangePreview,
  CoachWorkoutFields,
  PlanChange,
  WorkoutSnapshot,
} from "../../coach.js";
import { addWorkout, deleteWorkout, editWorkout, moveWorkout } from "../planMutations.js";
import { isIsoDate, parseNewWorkout, parseWorkoutUpdates, ValidationError } from "../validation.js";

/**
 * Plan changes proposed by the coach: validated when the coach proposes
 * them (so a bad proposal goes back to the model, not to the athlete), and
 * applied through the same mutations the plan view uses when the athlete
 * accepts them.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const STEP_TYPES: readonly StepType[] = ["warmup", "work", "recovery", "rest", "cooldown"];
const DURATION_UNITS: readonly DurationUnit[] = [
  "seconds",
  "minutes",
  "hours",
  "meters",
  "kilometers",
  "miles",
  "yards",
  "laps",
];
const INTENSITY_UNITS: readonly IntensityUnit[] = [
  "percent_ftp",
  "percent_lthr",
  "hr_zone",
  "pace_zone",
  "rpe",
  "css_offset",
];

function parseStep(input: unknown, where: string): WorkoutStep {
  if (!isPlainObject(input)) throw new ValidationError(`${where} must be an object`);
  const { type, name, duration, intensity, notes } = input;
  if (!STEP_TYPES.includes(type as StepType)) {
    throw new ValidationError(`${where}.type must be one of ${STEP_TYPES.join(", ")}`);
  }
  if (
    !isPlainObject(duration) ||
    !DURATION_UNITS.includes(duration.unit as DurationUnit) ||
    !isFiniteNumber(duration.value) ||
    duration.value <= 0
  ) {
    throw new ValidationError(`${where}.duration must be {unit, value > 0}`);
  }
  if (
    !isPlainObject(intensity) ||
    !INTENSITY_UNITS.includes(intensity.unit as IntensityUnit) ||
    !isFiniteNumber(intensity.value)
  ) {
    throw new ValidationError(`${where}.intensity must be {unit, value, ...}`);
  }
  const step: WorkoutStep = {
    type: type as StepType,
    duration: { unit: duration.unit as DurationUnit, value: duration.value },
    intensity: { unit: intensity.unit as IntensityUnit, value: intensity.value },
  };
  for (const key of ["valueLow", "valueHigh"] as const) {
    if (intensity[key] !== undefined && intensity[key] !== null) {
      if (!isFiniteNumber(intensity[key])) throw new ValidationError(`${where}.intensity.${key}`);
      step.intensity[key] = intensity[key];
    }
  }
  if (typeof intensity.description === "string") {
    step.intensity.description = intensity.description;
  }
  if (typeof name === "string") step.name = name;
  if (typeof notes === "string") step.notes = notes;
  return step;
}

/** Validates a workout's device-export structure (see StructuredWorkout). */
export function parseStructure(input: unknown): StructuredWorkout {
  if (!isPlainObject(input)) throw new ValidationError("structure must be an object");
  if (!Array.isArray(input.main) || input.main.length === 0) {
    throw new ValidationError("structure.main must be a non-empty array");
  }
  const steps = (value: unknown, where: string): WorkoutStep[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new ValidationError(`${where} must be an array`);
    return value.map((s, i) => parseStep(s, `${where}[${i}]`));
  };
  const main = input.main.map((item, i): WorkoutStep | IntervalSet => {
    const where = `structure.main[${i}]`;
    if (isPlainObject(item) && item.type === "interval_set") {
      if (!Number.isInteger(item.repeats) || (item.repeats as number) < 1) {
        throw new ValidationError(`${where}.repeats must be a whole number >= 1`);
      }
      const inner = steps(item.steps, `${where}.steps`);
      if (!inner?.length) throw new ValidationError(`${where}.steps must not be empty`);
      const set: IntervalSet = {
        type: "interval_set",
        repeats: item.repeats as number,
        steps: inner,
      };
      if (typeof item.name === "string") set.name = item.name;
      return set;
    }
    return parseStep(item, where);
  });
  const out: StructuredWorkout = { main };
  const warmup = steps(input.warmup, "structure.warmup");
  const cooldown = steps(input.cooldown, "structure.cooldown");
  if (warmup) out.warmup = warmup;
  if (cooldown) out.cooldown = cooldown;
  return out;
}

/** The workout fields, validated: the app's own rules plus the structure. */
export function parseFields(input: unknown, isNew: boolean): CoachWorkoutFields {
  if (!isPlainObject(input)) throw new ValidationError("workout fields must be an object");
  const { structure, ...rest } = input;
  const fields: CoachWorkoutFields = isNew ? parseNewWorkout(rest) : parseWorkoutUpdates(rest);
  if (structure !== undefined && structure !== null) fields.structure = parseStructure(structure);
  return fields;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireDate(value: unknown, name: string): string {
  if (!isIsoDate(value)) throw new ValidationError(`${name} must be a YYYY-MM-DD date`);
  return value;
}

/** Validates the changes in a propose_plan_changes call. */
export function parsePlanChanges(input: unknown): PlanChange[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("changes must be a non-empty array");
  }
  return input.map((raw, i): PlanChange => {
    if (!isPlainObject(raw)) throw new ValidationError(`changes[${i}] must be an object`);
    const reason = typeof raw.reason === "string" ? raw.reason : "";
    try {
      switch (raw.op) {
        case "move":
          return {
            op: "move",
            workoutId: requireString(raw.workoutId, "workoutId"),
            date: requireDate(raw.date, "date"),
            reason,
          };
        case "edit": {
          const updates = parseFields(raw.updates, false);
          if (Object.keys(updates).length === 0) throw new ValidationError("updates is empty");
          return {
            op: "edit",
            workoutId: requireString(raw.workoutId, "workoutId"),
            updates,
            reason,
          };
        }
        case "add":
          return {
            op: "add",
            date: requireDate(raw.date, "date"),
            workout: parseFields(raw.workout, true),
            reason,
          };
        case "delete":
          return { op: "delete", workoutId: requireString(raw.workoutId, "workoutId"), reason };
        default:
          throw new ValidationError(`op must be move, edit, add or delete`);
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new ValidationError(`changes[${i}]: ${err.message}`);
      }
      throw err;
    }
  });
}

function locate(plan: TrainingPlan, workoutId: string): { workout: Workout; date: string } | null {
  for (const week of plan.weeks ?? []) {
    for (const day of week.days ?? []) {
      const workout = (day.workouts ?? []).find((w) => w.id === workoutId);
      if (workout) return { workout, date: day.date };
    }
  }
  return null;
}

function snapshot(workout: Workout | CoachWorkoutFields, date: string): WorkoutSnapshot {
  return {
    date,
    name: workout.name ?? "",
    sport: workout.sport ?? "",
    durationMinutes: workout.durationMinutes ?? null,
  };
}

/** Sessions whose point is their intervals: exported without steps, the
 * watch would show one long block instead of the repeats. */
const QUALITY_TYPES = ["intervals", "tempo", "threshold", "vo2max", "sprint", "hills"];

/**
 * Refuses a quality run without its export steps. A generic warm-up/run/
 * cool-down is fine for an easy run, useless for 10 x 500 m.
 */
export function requireSteps(
  workout: Pick<Workout, "sport" | "type" | "name" | "structure">
): void {
  if (workout.sport === "run" && QUALITY_TYPES.includes(workout.type) && !workout.structure) {
    throw new ValidationError(
      `"${workout.name}" is a ${workout.type} session: give its structure (warm-up, the repeats as an interval_set with work and recovery steps, cool-down), or the watch gets one long block`
    );
  }
}

/** Editing what a session is without giving its new steps would leave the
 * old steps behind for the Garmin/FIT export; they're dropped instead, and
 * the export falls back to a generic warm-up/main/cool-down. */
const CONTENT_FIELDS = ["sport", "type", "durationMinutes", "distanceMeters", "humanReadable"];

/**
 * Applies the changes to the plan, in order, and returns what each did.
 * Throws on the first one that can't apply (unknown workout, date outside
 * the plan, a completed workout) - the caller works on a copy, so a
 * proposal applies whole or not at all.
 */
export function applyPlanChanges(plan: TrainingPlan, changes: PlanChange[]): ChangePreview[] {
  return changes.map((change, i) => {
    try {
      return applyOne(plan, change);
    } catch (err) {
      if (err instanceof Error) throw new ValidationError(`changes[${i}]: ${err.message}`);
      throw err;
    }
  });
}

function applyOne(plan: TrainingPlan, change: PlanChange): ChangePreview {
  if (change.op === "add") {
    const workout = {
      description: "",
      ...change.workout,
      id: `coach-${randomUUID()}`,
      completed: false,
    } as Workout;
    requireSteps(workout);
    addWorkout(plan, change.date, workout);
    return {
      op: "add",
      before: null,
      after: snapshot(workout, change.date),
      fields: [],
      reason: change.reason,
    };
  }

  const found = locate(plan, change.workoutId);
  if (!found) throw new ValidationError(`Workout ${change.workoutId} not found in this plan`);
  if (found.workout.completed) {
    throw new ValidationError(`Workout ${change.workoutId} is already completed - leave it as is`);
  }
  const before = snapshot(found.workout, found.date);

  switch (change.op) {
    case "move":
      moveWorkout(plan, change.workoutId, change.date);
      return {
        op: "move",
        before,
        after: snapshot(found.workout, change.date),
        fields: ["date"],
        reason: change.reason,
      };
    case "edit": {
      const { structure, ...updates } = change.updates;
      editWorkout(plan, change.workoutId, updates);
      if (structure) {
        found.workout.structure = structure;
      } else if (CONTENT_FIELDS.some((f) => f in updates)) {
        delete found.workout.structure;
        requireSteps(found.workout);
      }
      return {
        op: "edit",
        before,
        after: snapshot(found.workout, found.date),
        fields: Object.keys(change.updates),
        reason: change.reason,
      };
    }
    case "delete":
      deleteWorkout(plan, change.workoutId);
      return { op: "delete", before, after: null, fields: [], reason: change.reason };
  }
}
