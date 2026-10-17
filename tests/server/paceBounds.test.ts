import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { parseZones } from "../../src/lib/server/validation.js";
import { buildGarminWorkout } from "../../src/lib/server/garminConnect.js";
import {
  buildZonesFromSettings,
  deriveSettingsFromPlan,
  mergeRecalculatedRunPaceZones,
  recalculateRunPaceZones,
  rescaleRunPaceZones,
} from "../../src/lib/settings.js";
import type { TrainingPlan, Workout } from "../../src/schema/training-plan.js";

const samplePlan = (): TrainingPlan =>
  JSON.parse(readFileSync(new URL("../../examples/sample-plan.json", import.meta.url), "utf-8"));

describe("run pace zone bounds through Settings", () => {
  const planWithBounds = (): TrainingPlan => {
    const plan = samplePlan();
    plan.zones = {
      run: {
        pace: {
          thresholdPace: "4:26/km",
          thresholdPaceSeconds: 266,
          zones: [
            {
              zone: "E",
              name: "Easy (E)",
              pace: "5:41/km",
              paceSeconds: 341,
              low: "5:55/km",
              high: "5:28/km",
            },
            {
              zone: "RP",
              name: "Race Pace (RP)",
              pace: "4:44/km",
              paceSeconds: 284,
              low: "4:47/km",
              high: "4:41/km",
            },
          ],
        },
      },
    };
    return plan;
  };
  const runPaceZones = (settings: ReturnType<typeof deriveSettingsFromPlan>) =>
    buildZonesFromSettings(settings).run!.pace!.zones;

  it("survives a save with no edits, unchanged", () => {
    const zones = runPaceZones(deriveSettingsFromPlan(planWithBounds()));
    expect(zones[0]).toMatchObject({ zone: "E", low: "5:55/km", high: "5:28/km" });
    expect(zones[1]).toMatchObject({ zone: "RP", low: "4:47/km", high: "4:41/km" });
  });

  it("rescales with a manual pace edit", () => {
    const settings = deriveSettingsFromPlan(planWithBounds());
    settings.run.paceZones[0].pace = "6:00/km"; // 341s -> 360s, ratio ~1.0557
    const easy = runPaceZones(settings)[0];
    expect(easy.low).toBe("6:15/km"); // 355s * 1.0557 = 374.8
    expect(easy.high).toBe("5:46/km"); // 328s * 1.0557 = 346.3
  });

  it("rescales recalculated zones and keeps zones the recalculation doesn't cover", () => {
    const settings = deriveSettingsFromPlan(planWithBounds());
    settings.run.paceZones = mergeRecalculatedRunPaceZones(
      settings.run.paceZones,
      recalculateRunPaceZones("4:00") // E = round(240 * 1.18) = 283s = "4:43"
    );
    const zones = runPaceZones(settings);

    const easy = zones.find((z) => z.zone === "E")!;
    expect(easy.pace).toBe("4:43");
    // 283/341 of the original bounds, still slower-than / faster-than pace
    expect(easy.low).toBe("4:55/km");
    expect(easy.high).toBe("4:32/km");

    // RP isn't recalculated - kept with its original bounds
    expect(zones.find((z) => z.zone === "RP")).toMatchObject({ low: "4:47/km", high: "4:41/km" });
    // zones the plan never gave bounds to stay without them
    expect(zones.find((z) => z.zone === "T")!.low).toBeUndefined();
  });

  it("feeds the rescaled bounds to the Garmin export, not a +/-3% band", () => {
    const plan = planWithBounds();
    const settings = deriveSettingsFromPlan(plan);
    plan.zones = JSON.parse(JSON.stringify(buildZonesFromSettings(settings)));
    expect(() => parseZones(plan.zones)).not.toThrow();

    const workout = {
      id: "w",
      sport: "run",
      type: "endurance",
      name: "Easy",
      description: "",
      completed: false,
      structure: {
        main: [
          {
            type: "work",
            duration: { unit: "minutes", value: 30 },
            intensity: { unit: "pace_zone", value: 0, description: "E" },
          },
        ],
      },
    } as unknown as Workout;
    const step = (buildGarminWorkout(plan, workout) as any).workoutSegments[0].workoutSteps[0];
    expect(step.targetValueOne).toBeCloseTo(1000 / 355, 5); // 5:55/km
    expect(step.targetValueTwo).toBeCloseTo(1000 / 328, 5); // 5:28/km
  });

  it("Recalculate moves every zone with the threshold, keeping the plan's spacing", () => {
    const plan = planWithBounds();
    plan.zones!.run!.pace!.zones.push({
      zone: "T",
      name: "Threshold (T)",
      pace: "4:26/km",
      paceSeconds: 266,
    });
    const settings = deriveSettingsFromPlan(plan);
    // 4:26 -> 4:16: everything gets 10/266 faster, E and RP included.
    const zones = rescaleRunPaceZones(settings.run.paceZones, "4:16/km");
    const byCode = Object.fromEntries(zones.map((z) => [String(z.zone), z.pace]));
    expect(byCode).toMatchObject({ E: "5:28/km", RP: "4:33/km", T: "4:16/km" });
    settings.run.thresholdPace = "4:16/km";
    settings.run.paceZones = zones;
    const built = buildZonesFromSettings(settings).run!.pace!.zones.find((z) => z.zone === "E")!;
    expect(built).toMatchObject({ low: "5:41/km", high: "5:15/km" });
  });

  it("moves a step's own pace bounds with the threshold they were set against", () => {
    const plan = planWithBounds();
    plan.zones!.run!.pace!.thresholdPaceSeconds = 255;
    const workout = {
      id: "w",
      sport: "run",
      type: "intervals",
      name: "10 x 500 m",
      description: "",
      completed: false,
      structure: {
        main: [
          {
            type: "work",
            duration: { unit: "meters", value: 500 },
            intensity: {
              unit: "pace_zone",
              value: 0,
              valueLow: 248,
              valueHigh: 255,
              description: "5K pace",
              thresholdPaceSeconds: 260,
            },
          },
        ],
      },
    } as unknown as Workout;
    const step = (buildGarminWorkout(plan, workout) as any).workoutSegments[0].workoutSteps[0];
    expect(step.targetValueOne).toBeCloseTo(1000 / (255 * (255 / 260)), 5);
    expect(step.targetValueTwo).toBeCloseTo(1000 / (248 * (255 / 260)), 5);
  });
});
