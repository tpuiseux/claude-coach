/**
 * Garmin Connect structured workout export.
 *
 * Builds the raw JSON payload Garmin's workout-service API expects
 * (POST /workout-service/workout), so it can be uploaded via a local bridge
 * (scripts/garmin_bridge.py) that the "Send to Garmin" button in
 * WorkoutModal.svelte talks to over http://127.0.0.1.
 *
 * Mirrors export/fit.ts's approach: use workout.structure when present for
 * precise warmup/main/cooldown/interval steps with pace targets, and fall
 * back to a generic 3-block (warmup/main/cooldown) open-target workout when
 * a workout has no structure yet. That keeps every workout exportable today,
 * and any workout gets richer once its plan data includes `structure`.
 */

import type {
  Workout,
  Sport,
  StructuredWorkout,
  WorkoutStep,
  IntervalSet,
} from "../../../schema/training-plan.js";
import { planData } from "../../stores/plan.js";

// Garmin sport type ids (workout-service). Only sports with a confirmed
// typed workout class in the python-garminconnect library are supported —
// strength/rest/race/brick don't map cleanly to a device-guided workout.
const GARMIN_SPORT: Partial<Record<Sport, { sportTypeId: number; sportTypeKey: string }>> = {
  run: { sportTypeId: 1, sportTypeKey: "running" },
  bike: { sportTypeId: 2, sportTypeKey: "cycling" },
  swim: { sportTypeId: 4, sportTypeKey: "swimming" },
};

export function isGarminConnectSupported(sport: Sport): boolean {
  return sport in GARMIN_SPORT;
}

// Garmin workout-service type ids (see /workout-service/workout/types)
const GarminStepType = {
  warmup: { id: 1, key: "warmup" },
  cooldown: { id: 2, key: "cooldown" },
  work: { id: 3, key: "interval" },
  recovery: { id: 4, key: "recovery" },
  rest: { id: 5, key: "rest" },
  repeat: { id: 6, key: "repeat" },
};

const GARMIN_TARGET_NO_TARGET = {
  workoutTargetTypeId: 1,
  workoutTargetTypeKey: "no.target",
  displayOrder: 1,
};
const GARMIN_TARGET_PACE_ZONE = {
  workoutTargetTypeId: 6,
  workoutTargetTypeKey: "pace.zone",
  displayOrder: 6,
};
const GARMIN_CONDITION_TIME = {
  conditionTypeId: 2,
  conditionTypeKey: "time",
  displayOrder: 2,
  displayable: true,
};
const GARMIN_CONDITION_DISTANCE = {
  conditionTypeId: 3,
  conditionTypeKey: "distance",
  displayOrder: 3,
  displayable: true,
};
const GARMIN_CONDITION_ITERATIONS = {
  conditionTypeId: 7,
  conditionTypeKey: "iterations",
  displayOrder: 7,
  displayable: false,
};

interface OrderCounter {
  n: number;
}

function nextStepOrder(order: OrderCounter): number {
  order.n += 1;
  return order.n;
}

function paceToSpeedMps(pace: string): number {
  const clean = pace.replace("/km", "").trim();
  const [minStr, secStr] = clean.split(":");
  const totalSeconds = Number(minStr) * 60 + Number(secStr ?? "0");
  return totalSeconds > 0 ? 1000 / totalSeconds : 0;
}

interface SpeedRange {
  min: number;
  max: number;
}

/** Look up a named pace zone from the plan's own computed zones (not app Settings —
 * this plan's zones carry precise low/high bounds; Settings only has a single
 * point value per zone). Falls back to a +/-3% band around the point value for
 * plans that only provide `pace` (schema-minimal case). */
function findPlanPaceZoneSpeedRange(description?: string): SpeedRange | null {
  if (!description) return null;
  const zones = planData.zones?.run?.pace?.zones ?? [];
  const match = zones.find((z) => z.zone === description || z.name === description) as
    | ((typeof zones)[number] & { low?: string; high?: string })
    | undefined;
  if (!match) return null;

  if (match.low && match.high) {
    return { min: paceToSpeedMps(match.low), max: paceToSpeedMps(match.high) };
  }
  if (match.pace) {
    const mid = paceToSpeedMps(match.pace);
    return { min: mid * 0.97, max: mid * 1.03 };
  }
  return null;
}

function resolveTarget(step: WorkoutStep): {
  targetType: Record<string, unknown>;
  targetValueOne?: number;
  targetValueTwo?: number;
} {
  if (step.intensity?.unit === "pace_zone") {
    // Prefer explicit valueLow/valueHigh (seconds/km; valueLow = faster/smaller,
    // valueHigh = slower/larger) when the plan sets them directly on the step —
    // more precise than a named-zone lookup, and works for blended/custom paces
    // that don't line up with a single named zone.
    if (step.intensity.valueLow !== undefined && step.intensity.valueHigh !== undefined) {
      return {
        targetType: GARMIN_TARGET_PACE_ZONE,
        targetValueOne: 1000 / step.intensity.valueHigh, // slower bound -> lower speed
        targetValueTwo: 1000 / step.intensity.valueLow, // faster bound -> higher speed
      };
    }
    const range = findPlanPaceZoneSpeedRange(step.intensity.description);
    if (range) {
      return {
        targetType: GARMIN_TARGET_PACE_ZONE,
        targetValueOne: range.min,
        targetValueTwo: range.max,
      };
    }
  }
  return { targetType: GARMIN_TARGET_NO_TARGET };
}

function resolveEndCondition(duration: WorkoutStep["duration"]): {
  condition: Record<string, unknown>;
  value: number;
} {
  const unit = duration?.unit ?? "minutes";
  const value = duration?.value ?? 0;

  if (unit === "meters" || unit === "kilometers" || unit === "miles") {
    const meters =
      unit === "kilometers" ? value * 1000 : unit === "miles" ? value * 1609.34 : value;
    return { condition: GARMIN_CONDITION_DISTANCE, value: meters };
  }
  const seconds = unit === "hours" ? value * 3600 : unit === "minutes" ? value * 60 : value;
  return { condition: GARMIN_CONDITION_TIME, value: seconds };
}

function stepKind(type: WorkoutStep["type"]): keyof typeof GarminStepType {
  switch (type) {
    case "warmup":
      return "warmup";
    case "cooldown":
      return "cooldown";
    case "recovery":
      return "recovery";
    case "rest":
      return "rest";
    default:
      return "work";
  }
}

function buildExecutableStep(step: WorkoutStep, order: OrderCounter): Record<string, unknown> {
  const kind = GarminStepType[stepKind(step.type)];
  const end = resolveEndCondition(step.duration);
  const target = resolveTarget(step);

  const out: Record<string, unknown> = {
    type: "ExecutableStepDTO",
    stepOrder: nextStepOrder(order),
    stepType: { stepTypeId: kind.id, stepTypeKey: kind.key, displayOrder: kind.id },
    endCondition: end.condition,
    endConditionValue: end.value,
    targetType: target.targetType,
  };
  if (target.targetValueOne !== undefined) out.targetValueOne = target.targetValueOne;
  if (target.targetValueTwo !== undefined) out.targetValueTwo = target.targetValueTwo;
  return out;
}

function buildRepeatGroup(intervalSet: IntervalSet, order: OrderCounter): Record<string, unknown> {
  const groupOrder = nextStepOrder(order);
  const children = intervalSet.steps.map((s) => buildExecutableStep(s, order));
  return {
    type: "RepeatGroupDTO",
    stepOrder: groupOrder,
    stepType: {
      stepTypeId: GarminStepType.repeat.id,
      stepTypeKey: GarminStepType.repeat.key,
      displayOrder: GarminStepType.repeat.id,
    },
    numberOfIterations: intervalSet.repeats,
    workoutSteps: children,
    endCondition: GARMIN_CONDITION_ITERATIONS,
    endConditionValue: intervalSet.repeats,
  };
}

function stepsFromStructure(
  structure: StructuredWorkout,
  order: OrderCounter
): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  structure.warmup?.forEach((s) => steps.push(buildExecutableStep(s, order)));
  for (const item of structure.main) {
    if ("repeats" in item) {
      steps.push(buildRepeatGroup(item as IntervalSet, order));
    } else {
      steps.push(buildExecutableStep(item as WorkoutStep, order));
    }
  }
  structure.cooldown?.forEach((s) => steps.push(buildExecutableStep(s, order)));
  return steps;
}

/** Generic warmup/main/cooldown split used when a workout has no `structure` yet. */
function simpleSteps(workout: Workout, order: OrderCounter): Record<string, unknown>[] {
  const totalMinutes = workout.durationMinutes || 60;
  const warmupMinutes = Math.min(15, Math.max(5, Math.round(totalMinutes * 0.1)));
  const cooldownMinutes = Math.min(10, Math.max(5, Math.round(totalMinutes * 0.1)));
  const mainMinutes = Math.max(1, totalMinutes - warmupMinutes - cooldownMinutes);

  const openStep = (type: WorkoutStep["type"], minutes: number): WorkoutStep => ({
    type,
    duration: { unit: "minutes", value: minutes },
    intensity: { unit: "rpe", value: 0 },
  });

  return [
    buildExecutableStep(openStep("warmup", warmupMinutes), order),
    buildExecutableStep(openStep("work", mainMinutes), order),
    buildExecutableStep(openStep("cooldown", cooldownMinutes), order),
  ];
}

/** Build a Garmin Connect workout-service payload for any supported workout. */
export function buildGarminWorkout(workout: Workout): Record<string, unknown> | null {
  const sport = GARMIN_SPORT[workout.sport];
  if (!sport) return null;

  const order: OrderCounter = { n: 0 };
  const steps = workout.structure
    ? stepsFromStructure(workout.structure, order)
    : simpleSteps(workout, order);

  return {
    workoutName: workout.name,
    sportType: sport,
    estimatedDurationInSecs: Math.round((workout.durationMinutes || 60) * 60),
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: sport,
        workoutSteps: steps,
      },
    ],
  };
}
