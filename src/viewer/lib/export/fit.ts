/**
 * FIT (Garmin) Workout Export
 *
 * Generates Garmin FIT workout files that can be uploaded to Garmin Connect.
 * Uses the official @garmin/fitsdk package for binary FIT encoding.
 *
 * How to import to Garmin:
 * - Upload to Garmin Connect (connect.garmin.com) -> Training -> Workouts -> Import
 * - The workout will sync to compatible Garmin devices
 */

import type {
  Workout,
  Sport,
  StructuredWorkout,
  WorkoutStep,
  IntervalSet,
} from "../../../schema/training-plan.js";
import type { Settings } from "../../stores/settings.js";
import { Encoder, Profile } from "@garmin/fitsdk";

/**
 * Check if the FIT SDK is available at runtime
 * Always returns true since the SDK is now bundled
 */
export async function isFitSdkAvailable(): Promise<boolean> {
  return true;
}

/**
 * Check if a sport is supported by FIT export
 */
export function isFitSupported(sport: Sport): boolean {
  // FIT supports most sports, excluding rest and race-specific
  return sport !== "rest" && sport !== "race";
}

/**
 * Map our sport types to FIT sport enum values
 */
function getFitSport(sport: Sport): string {
  switch (sport) {
    case "swim":
      return "swimming";
    case "bike":
      return "cycling";
    case "run":
      return "running";
    case "strength":
      return "training";
    case "brick":
      return "multisport";
    default:
      return "generic";
  }
}

/**
 * Map our sport types to FIT sub_sport enum values
 */
function getFitSubSport(sport: Sport): string {
  switch (sport) {
    case "swim":
      return "lap_swimming";
    case "bike":
      return "road";
    case "run":
      return "generic";
    case "strength":
      return "strength_training";
    case "brick":
      return "triathlon";
    default:
      return "generic";
  }
}

/**
 * Get workout step intensity/duration type based on step type
 */
function getStepIntensity(stepType: string): string {
  switch (stepType) {
    case "warmup":
      return "warmup";
    case "cooldown":
      return "cooldown";
    case "rest":
      return "rest";
    case "recovery":
      return "recovery";
    case "work":
      return "active";
    default:
      return "active";
  }
}

/**
 * Convert duration to FIT workout step duration
 */
function getDurationValue(value: number, unit: string): number {
  switch (unit) {
    case "seconds":
      return value * 1000; // FIT uses milliseconds
    case "minutes":
      return value * 60 * 1000;
    case "hours":
      return value * 3600 * 1000;
    case "meters":
      return value * 100; // FIT uses centimeters
    case "kilometers":
      return value * 100000;
    case "miles":
      return value * 160934; // cm per mile
    default:
      return value * 1000;
  }
}

/**
 * Get duration type for FIT
 */
function getDurationType(unit: string): string {
  switch (unit) {
    case "seconds":
    case "minutes":
    case "hours":
      return "time";
    case "meters":
    case "kilometers":
    case "miles":
      return "distance";
    default:
      return "time";
  }
}

/**
 * Convert pace string (mm:ss per km) to speed in m/s * 1000 for FIT
 */
function paceToFitSpeed(pace: string): number {
  const parts = pace.split(":");
  const minutes = parseInt(parts[0], 10);
  const seconds = parseInt(parts[1] || "0", 10);
  const totalSeconds = minutes * 60 + seconds;
  if (totalSeconds === 0) return 0;
  // pace is min/km, speed is m/s, FIT stores speed * 1000
  return Math.round((1000 / totalSeconds) * 1000);
}

/**
 * Build a FIT workout step object with a consistent field set.
 * All steps use the same fields to avoid @garmin/fitsdk Encoder
 * message definition conflicts when alternating field layouts.
 */
function buildFitStep(
  index: number,
  opts: {
    durationType: string;
    durationValue: number;
    targetType: string;
    targetValue: number;
    intensity: string;
    customTargetValueLow?: number;
    customTargetValueHigh?: number;
  }
): Record<string, unknown> {
  return {
    messageIndex: index,
    durationType: opts.durationType,
    durationValue: opts.durationValue,
    targetType: opts.targetType,
    targetValue: opts.targetValue,
    intensity: opts.intensity,
    customTargetValueLow: opts.customTargetValueLow ?? 0,
    customTargetValueHigh: opts.customTargetValueHigh ?? 0,
  };
}

/**
 * Resolve target fields for a workout step based on its intensity
 */
function resolveTarget(
  step: WorkoutStep,
  settings: Settings
): { targetType: string; targetValue: number; customLow: number; customHigh: number } {
  if (!step.intensity) {
    return { targetType: "open", targetValue: 0, customLow: 0, customHigh: 0 };
  }

  const intensityValue = step.intensity.value ?? 50;

  switch (step.intensity.unit) {
    case "percent_ftp":
      return {
        targetType: "power",
        targetValue: 0,
        customLow: step.intensity.valueLow ?? intensityValue - 5,
        customHigh: step.intensity.valueHigh ?? intensityValue + 5,
      };

    case "percent_lthr":
    case "hr_zone":
      if (step.intensity.valueLow !== undefined && step.intensity.valueHigh !== undefined) {
        return {
          targetType: "heartRate",
          targetValue: 0,
          customLow: step.intensity.valueLow,
          customHigh: step.intensity.valueHigh,
        };
      }
      return {
        targetType: "heartRate",
        targetValue: intensityValue,
        customLow: 0,
        customHigh: 0,
      };

    case "pace_zone": {
      const paceZones = settings.run?.paceZones;
      if (paceZones && paceZones.length > 0) {
        const zone = paceZones.find(
          (z) => z.zone === step.intensity!.description || z.name === step.intensity!.description
        );
        if (zone) {
          const speed = paceToFitSpeed(zone.pace);
          // ±3% range around the target pace
          return {
            targetType: "speed",
            targetValue: 0,
            customLow: Math.round(speed * 0.97),
            customHigh: Math.round(speed * 1.03),
          };
        }
      }
      return { targetType: "open", targetValue: 0, customLow: 0, customHigh: 0 };
    }

    case "rpe":
      return { targetType: "open", targetValue: 0, customLow: 0, customHigh: 0 };

    default:
      return { targetType: "open", targetValue: 0, customLow: 0, customHigh: 0 };
  }
}

/**
 * Generate workout steps from structured workout
 */
function generateStepsFromStructure(
  structure: StructuredWorkout,
  settings: Settings
): {
  steps: Record<string, unknown>[];
  totalSteps: number;
} {
  const steps: Record<string, unknown>[] = [];
  let stepIndex = 0;

  const addStep = (step: WorkoutStep) => {
    const target = resolveTarget(step, settings);
    steps.push(
      buildFitStep(stepIndex, {
        durationType: getDurationType(step.duration?.unit ?? "minutes"),
        durationValue: getDurationValue(
          step.duration?.value ?? 0,
          step.duration?.unit ?? "minutes"
        ),
        targetType: target.targetType,
        targetValue: target.targetValue,
        intensity: getStepIntensity(step.type),
        customTargetValueLow: target.customLow,
        customTargetValueHigh: target.customHigh,
      })
    );
    stepIndex++;
  };

  const addIntervalSet = (intervalSet: IntervalSet) => {
    // Add child steps FIRST
    const firstChildIndex = stepIndex;
    for (const childStep of intervalSet.steps) {
      addStep(childStep);
    }

    // Add repeat step AFTER children (Garmin convention)
    // durationValue = index of first child step to repeat from
    // targetValue = number of repetitions
    steps.push(
      buildFitStep(stepIndex, {
        durationType: "repeatUntilStepsCmplt",
        durationValue: firstChildIndex,
        targetType: "open",
        targetValue: intervalSet.repeats,
        intensity: "rest",
      })
    );
    stepIndex++;
  };

  if (structure.warmup) {
    for (const step of structure.warmup) {
      addStep(step);
    }
  }

  for (const item of structure.main) {
    if ("repeats" in item) {
      addIntervalSet(item as IntervalSet);
    } else {
      addStep(item as WorkoutStep);
    }
  }

  if (structure.cooldown) {
    for (const step of structure.cooldown) {
      addStep(step);
    }
  }

  return { steps, totalSteps: steps.length };
}

/**
 * Generate simple workout steps when no structure is provided
 */
function generateSimpleSteps(workout: Workout): {
  steps: Record<string, unknown>[];
  totalSteps: number;
} {
  const totalMinutes = workout.durationMinutes || 60;

  const warmupMinutes = Math.min(15, Math.max(5, Math.round(totalMinutes * 0.1)));
  const cooldownMinutes = Math.min(10, Math.max(5, Math.round(totalMinutes * 0.1)));
  const mainMinutes = totalMinutes - warmupMinutes - cooldownMinutes;

  let mainIntensity = "active";
  if (workout.type === "recovery") mainIntensity = "recovery";
  else if (workout.type === "rest") mainIntensity = "rest";
  else if (workout.type === "intervals" || workout.type === "vo2max") mainIntensity = "interval";

  const steps = [
    buildFitStep(0, {
      durationType: "time",
      durationValue: warmupMinutes * 60 * 1000,
      targetType: "open",
      targetValue: 0,
      intensity: "warmup",
    }),
    buildFitStep(1, {
      durationType: "time",
      durationValue: mainMinutes * 60 * 1000,
      targetType: "open",
      targetValue: 0,
      intensity: mainIntensity,
    }),
    buildFitStep(2, {
      durationType: "time",
      durationValue: cooldownMinutes * 60 * 1000,
      targetType: "open",
      targetValue: 0,
      intensity: "cooldown",
    }),
  ];

  return { steps, totalSteps: 3 };
}

/**
 * Generate a complete FIT workout file
 */
export async function generateFit(workout: Workout, settings: Settings): Promise<Uint8Array> {
  if (!isFitSupported(workout.sport)) {
    throw new Error(`FIT export not supported for ${workout.sport} workouts`);
  }

  const encoder = new Encoder();

  // File ID message (required)
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: "workout",
    manufacturer: "garmin",
    garminProduct: "connect",
    product: 65534,
    serialNumber: Math.floor(Math.random() * 1000000),
    timeCreated: new Date(),
  });

  // File Creator message
  encoder.onMesg(Profile.MesgNum.FILE_CREATOR, {
    softwareVersion: 1,
    hardwareVersion: 0,
  });

  // Generate steps
  const { steps, totalSteps } = workout.structure
    ? generateStepsFromStructure(workout.structure, settings)
    : generateSimpleSteps(workout);

  // Workout message
  encoder.onMesg(Profile.MesgNum.WORKOUT, {
    capabilities: "tcx",
    wktName: workout.name,
    wktDescription: workout.name,
    sport: getFitSport(workout.sport),
    subSport: getFitSubSport(workout.sport),
    numValidSteps: totalSteps,
  });

  // Write workout steps
  for (const step of steps) {
    encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, step);
  }

  // Finalize and return
  return encoder.close();
}
