import { describe, it, expect } from "vitest";
import {
  buildLoadSeries,
  fatigueSignals,
  loadFromActivities,
  type LoadDay,
  type WellnessRow,
} from "../../src/lib/load.js";

function row(date: string, extra: Partial<WellnessRow> = {}): WellnessRow {
  return {
    date,
    acute_training_load: null,
    chronic_training_load: null,
    acwr: null,
    hrv_last_night_avg: null,
    hrv_weekly_avg: null,
    hrv_status: null,
    sleep_score: null,
    resting_hr: null,
    training_readiness_score: null,
    ...extra,
  };
}

function day(date: string, extra: Partial<LoadDay> = {}): LoadDay {
  return {
    date,
    acute: null,
    chronic: null,
    acwr: null,
    hrv: null,
    hrvWeekly: null,
    hrvStatus: null,
    sleepScore: null,
    restingHr: null,
    readiness: null,
    ...extra,
  };
}

const dates = (n: number, from = "2026-10-01") =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

describe("buildLoadSeries", () => {
  it("uses Garmin's load, one entry per day, gaps as nulls", () => {
    const s = buildLoadSeries(
      [
        row("2026-10-01", {
          acute_training_load: 500,
          chronic_training_load: 450,
          acwr: 1.1,
          hrv_last_night_avg: 60,
        }),
        row("2026-10-03", {
          acute_training_load: 520,
          chronic_training_load: 455,
          acwr: 1.14,
          sleep_score: 81,
        }),
      ],
      { "2026-10-02": 999 },
      "2026-10-01",
      "2026-10-03"
    );
    expect(s.loadSource).toBe("garmin");
    expect(s.days.map((d) => d.acute)).toEqual([500, null, 520]);
    expect(s.days[0]).toMatchObject({ chronic: 450, acwr: 1.1, hrv: 60 });
    expect(s.days[2].sleepScore).toBe(81);
  });

  it("works load out from activities when Garmin has none", () => {
    const s = buildLoadSeries(
      [],
      { "2026-10-01": 100, "2026-10-02": 100 },
      "2026-10-01",
      "2026-10-02"
    );
    expect(s.loadSource).toBe("activities");
    expect(s.days[1].acute).toBeGreaterThan(s.days[0].acute!);
    expect(s.days[1].acwr).toBeCloseTo(s.days[1].acute! / s.days[1].chronic!, 2);
  });

  it("steady training settles at a weekly load and ACWR 1", () => {
    const load = Object.fromEntries(dates(200, "2026-01-01").map((d) => [d, 100]));
    const out = loadFromActivities(load, "2026-07-01", "2026-07-01");
    expect(out["2026-07-01"].acute).toBeCloseTo(700, 0);
    expect(out["2026-07-01"].chronic).toBeCloseTo(700, 0);
  });
});

describe("fatigueSignals", () => {
  it("is quiet when all is well", () => {
    const days = dates(30).map((d) =>
      day(d, { acwr: 1.1, hrvStatus: "BALANCED", readiness: 70, sleepScore: 80, restingHr: 48 })
    );
    expect(fatigueSignals(days)).toEqual([]);
  });

  it("flags streaks and a rising resting heart rate", () => {
    const days = dates(30).map((d, i) =>
      day(d, {
        acwr: i === 29 ? 1.62 : 1.2,
        hrvStatus: i >= 26 ? "LOW" : "BALANCED",
        readiness: i >= 27 ? 30 : 70,
        // A night without data doesn't break the streak.
        sleepScore: i === 28 ? null : i >= 26 ? 50 : 80,
        restingHr: i >= 27 ? 55 : 48,
      })
    );
    expect(fatigueSignals(days).map((s) => s.key)).toEqual([
      "acwr",
      "hrv",
      "readiness",
      "sleep",
      "restingHr",
    ]);
    expect(fatigueSignals(days)[1].text).toBe("HRV below your normal range 4 days running");
  });

  it("needs three days in a row", () => {
    const days = dates(10).map((d, i) => day(d, { hrvStatus: i === 7 ? "BALANCED" : "LOW" }));
    expect(fatigueSignals(days)).toEqual([]);
  });
});
