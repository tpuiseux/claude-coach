import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  ValidationError,
  isIsoDate,
  parseNewWorkout,
  parsePreferences,
  parseWorkoutUpdates,
  parseZones,
} from "../../src/lib/server/validation.js";
import { editWorkout } from "../../src/lib/server/planMutations.js";
import {
  buildPreferencesFromSettings,
  buildZonesFromSettings,
  deriveSettingsFromPlan,
  recalculateRunPaceZones,
} from "../../src/lib/settings.js";
import type { TrainingPlan, Workout } from "../../src/schema/training-plan.js";

const samplePlan = (): TrainingPlan =>
  JSON.parse(readFileSync(new URL("../../examples/sample-plan.json", import.meta.url), "utf-8"));

describe("parseWorkoutUpdates", () => {
  it("accepts exactly what the WorkoutModal sends", () => {
    const updates = {
      sport: "run",
      type: "tempo",
      name: "Tempo",
      description: "",
      durationMinutes: 45,
      distanceMeters: 9000,
      primaryZone: "T",
      humanReadable: "15' E / 20' T / 10' E",
    };
    expect(parseWorkoutUpdates(updates)).toEqual(updates);
  });

  it("rejects server-owned and unknown fields", () => {
    expect(() => parseWorkoutUpdates({ id: "other" })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ completed: true })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ structure: {} })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ isAdmin: true })).toThrow(ValidationError);
  });

  it("rejects wrongly-typed values", () => {
    expect(() => parseWorkoutUpdates({ sport: "curling" })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ durationMinutes: "45" })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ durationMinutes: -5 })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ rpe: 11 })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates({ name: 42 })).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates(null)).toThrow(ValidationError);
    expect(() => parseWorkoutUpdates([])).toThrow(ValidationError);
  });

  it("skips nulls (NaN from a cleared number input serializes to null)", () => {
    expect(parseWorkoutUpdates({ name: "Easy", durationMinutes: null })).toEqual({ name: "Easy" });
  });

  it("does not let a __proto__ key change the result's prototype", () => {
    const parsed = parseWorkoutUpdates(JSON.parse('{"name":"x"}'));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(() => parseWorkoutUpdates(JSON.parse('{"__proto__":{"polluted":1}}'))).toThrow(
      ValidationError
    );
    expect(() => parseWorkoutUpdates({ toString: "x" })).toThrow(ValidationError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parseNewWorkout", () => {
  it("requires sport, type and name, and defaults description", () => {
    expect(parseNewWorkout({ sport: "run", type: "endurance", name: "Easy" })).toEqual({
      sport: "run",
      type: "endurance",
      name: "Easy",
      description: "",
    });
    expect(() => parseNewWorkout({ sport: "run", type: "endurance" })).toThrow(/name/);
  });
});

describe("editWorkout", () => {
  it("never changes a workout's id or completion, even if a caller skips validation", () => {
    const plan = samplePlan();
    const workout = plan.weeks.flatMap((w) => w.days).flatMap((d) => d.workouts)[0];
    const originalId = workout.id;

    editWorkout(plan, originalId, {
      id: "hijacked",
      completed: !workout.completed,
      name: "Renamed",
    } as Partial<Workout>);

    expect(workout.id).toBe(originalId);
    expect(workout.name).toBe("Renamed");
  });
});

describe("isIsoDate", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(isIsoDate("2026-11-01")).toBe(true);
    expect(isIsoDate("2026-13-45")).toBe(false);
    expect(isIsoDate("01/11/2026")).toBe(false);
    expect(isIsoDate("2026-11-01/../x")).toBe(false);
    expect(isIsoDate(20261101)).toBe(false);
  });
});

describe("settings validation", () => {
  it("accepts what the Settings UI builds from a real plan (round trip)", () => {
    const settings = deriveSettingsFromPlan(samplePlan());
    expect(() => parsePreferences(buildPreferencesFromSettings(settings))).not.toThrow();
    // Through JSON, exactly as the browser sends it (NaN -> null etc.)
    const zones = JSON.parse(JSON.stringify(buildZonesFromSettings(settings)));
    expect(() => parseZones(zones)).not.toThrow();
  });

  it("accepts recalculated pace zones for any threshold pace", () => {
    for (let seconds = 180; seconds <= 420; seconds += 1) {
      const pace = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      const zones = recalculateRunPaceZones(pace).map((z) => ({
        zone: String(z.zone),
        name: z.name,
        pace: z.pace,
      }));
      expect(() => parseZones({ run: { pace: { thresholdPace: pace, zones } } })).not.toThrow();
    }
  });

  it("accepts the plan-generated pace zone shape (low/high bounds)", () => {
    const zones = {
      run: {
        pace: {
          thresholdPace: "4:26/km",
          thresholdPaceSeconds: 266,
          zones: [
            {
              name: "Easy (E)",
              zone: "E",
              low: "5:55/km",
              high: "5:28/km",
              pace: "5:41/km",
              paceSeconds: 341,
            },
          ],
        },
      },
    };
    expect(() => parseZones(zones)).not.toThrow();
  });

  it("keeps extra preference keys some plans carry, but checks known ones", () => {
    expect(() =>
      parsePreferences({
        bike: "kilometers",
        run: "kilometers",
        ski: "kilometers",
        firstDayOfWeek: "monday",
      })
    ).not.toThrow();
    expect(() => parsePreferences({ run: "furlongs" })).toThrow(ValidationError);
    expect(() => parsePreferences({ ski: 3 })).toThrow(ValidationError);
    expect(() => parsePreferences({ toString: "x" })).not.toThrow();
  });

  it("rejects unparseable paces and wrongly-typed numbers", () => {
    expect(() => parseZones({ run: { pace: { zones: [{ zone: "E", pace: "fast" }] } } })).toThrow(
      /valid pace/
    );
    expect(() => parseZones({ run: { pace: { zones: "E" } } })).toThrow(ValidationError);
    expect(() => parseZones({ bike: { power: { ftp: "250" } } })).toThrow(ValidationError);
    expect(() => parseZones({ maxHR: "190" })).toThrow(ValidationError);
    expect(() => parseZones([])).toThrow(ValidationError);
  });
});
