import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { parseZones } from "../../src/lib/server/validation.js";
import { buildZonesFromSettings, deriveSettingsFromPlan } from "../../src/lib/settings.js";
import type { TrainingPlan } from "../../src/schema/training-plan.js";

const samplePlan = (): TrainingPlan =>
  JSON.parse(readFileSync(new URL("../../examples/sample-plan.json", import.meta.url), "utf-8"));

describe("split HR zones", () => {
  it("keep their ids (5a, 5b) through the settings and back into the plan", () => {
    const plan = samplePlan();
    plan.zones = {
      ...plan.zones,
      run: {
        ...plan.zones?.run,
        hr: {
          lthr: 176,
          zones: [
            {
              zone: 4,
              name: "Sub-threshold",
              percentLow: 94,
              percentHigh: 99,
              hrLow: 165,
              hrHigh: 174,
            },
            {
              zone: "5a",
              name: "Threshold",
              percentLow: 100,
              percentHigh: 102,
              hrLow: 176,
              hrHigh: 180,
            },
            {
              zone: "5b",
              name: "VO2max",
              percentLow: 103,
              percentHigh: 106,
              hrLow: 181,
              hrHigh: 187,
            },
          ],
        },
      },
    };

    const settings = deriveSettingsFromPlan(plan);
    expect(settings.run.hrZones.map((z) => z.zone)).toEqual([4, "5a", "5b"]);

    // What the Settings modal sends back on save, through the server's check.
    const saved = parseZones(JSON.parse(JSON.stringify(buildZonesFromSettings(settings))));
    expect(saved.run?.hr?.zones.map((z) => z.zone)).toEqual([4, "5a", "5b"]);
  });
});
