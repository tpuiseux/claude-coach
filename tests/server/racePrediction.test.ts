import { describe, it, expect } from "vitest";
import {
  danielsSeconds,
  fastestStretch,
  kilometreSplits,
  predictAt,
  racePrediction,
  raceTarget,
  riegel,
  speedAtHr,
  summarizeRun,
  tandaMarathonSeconds,
  vdot,
  type RaceTarget,
  type RunSummary,
} from "../../src/lib/racePrediction.js";
import type { TrainingPlan } from "../../src/schema/training-plan.js";

function plan(overrides: Record<string, unknown> = {}): TrainingPlan {
  return {
    meta: { event: "Marathon de Toulouse", planStartDate: "2026-09-07", eventDate: "2026-11-01" },
    zones: {
      run: {
        hr: { lthr: 176, zones: [] },
        pace: { goalTime: "3:12:00 (goal range 3:10:00-3:15:00)" },
      },
    },
    raceStrategy: {
      event: { name: "Marathon de Toulouse", type: "Marathon", distances: { run: 42.195 } },
      pacing: { run: { targetPace: "4:33/km", targetHR: "150-158 (85-88% LTHR)", notes: "" } },
    },
    ...overrides,
  } as unknown as TrainingPlan;
}

/** A steady run sampled every 10 s: `pace` s/km, heart rate `hr`. */
function steadySeries(km: number, pace: number, hr: number) {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  for (let t = 0; (t / pace) * 1000 <= km * 1000; t += 10) {
    time.push(t);
    distance.push((t / pace) * 1000);
    heartrate.push(hr);
  }
  return { time, distance, heartrate };
}

function run(date: string, km: number, pace: number, hr = 140): RunSummary {
  return summarizeRun(
    {
      id: Number(date.replace(/-/g, "")),
      date,
      distanceMeters: km * 1000,
      movingSeconds: km * pace,
    },
    steadySeries(km, pace, hr)
  );
}

describe("raceTarget", () => {
  it("reads distance, goal and race heart rate from the plan", () => {
    expect(raceTarget(plan())).toEqual({ distanceMeters: 42195, goalSeconds: 11520, raceHr: 154 });
  });

  it("falls back to the target pace and threshold heart rate", () => {
    const p = plan({
      zones: { run: { hr: { lthr: 176, zones: [] } } },
      raceStrategy: {
        event: { name: "Semi", type: "Half Marathon" },
        pacing: { run: { targetPace: "4:20/km", targetHR: "", notes: "" } },
      },
    });
    expect(raceTarget(p)).toEqual({
      distanceMeters: 21097.5,
      goalSeconds: Math.round(260 * 21.0975),
      raceHr: Math.round(176 * 0.93),
    });
  });

  it("skips triathlons", () => {
    const p = plan({
      raceStrategy: {
        event: { name: "70.3", type: "triathlon", distances: { swim: 1900, bike: 90, run: 21.1 } },
      },
    });
    expect(raceTarget(p)).toBeNull();
  });
});

describe("models", () => {
  it("Riegel carries a 10K over to the marathon", () => {
    // 42:03 for 10 km -> 3:13:26.
    expect(riegel(2523, 10000, 42195)).toBeCloseTo(3 * 3600 + 13 * 60 + 26, 0);
  });

  it("Daniels: VDOT 50 is a 3:10:49 marathon, and round-trips", () => {
    // The published tables are rounded: within half a minute.
    expect(Math.abs(danielsSeconds(50, 42195) - (3 * 3600 + 10 * 60 + 49))).toBeLessThan(30);
    expect(vdot(10000, danielsSeconds(55, 10000))).toBeCloseTo(55, 3);
  });

  it("Tanda: more volume, faster marathon", () => {
    const low = tandaMarathonSeconds(40, 320);
    const high = tandaMarathonSeconds(80, 320);
    expect(high).toBeLessThan(low);
    // 17.1 + 140·e^(-0.212) + 176 = 306.4 s/km
    expect(low / 42.195).toBeCloseTo(306.4, 0);
  });
});

describe("run summaries", () => {
  it("finds the fastest stretch, pauses excluded", () => {
    const pts = [
      { d: 0, t: 0, hr: null },
      { d: 1000, t: 300, hr: null },
      { d: 2000, t: 540, hr: null }, // 240 s km
      { d: 3000, t: 840, hr: null },
    ];
    expect(fastestStretch(pts, 1000)).toBe(240);
    expect(fastestStretch(pts, 2000)).toBe(540);
    expect(fastestStretch(pts, 5000)).toBeNull();
  });

  it("splits full kilometres after the first", () => {
    const s = steadySeries(5.2, 300, 150);
    const pts = s.time.map((t, i) => ({ d: s.distance[i], t, hr: s.heartrate[i] }));
    const splits = kilometreSplits(pts);
    expect(splits).toHaveLength(4);
    for (const split of splits) {
      expect(split.speed).toBeCloseTo(1000 / 300, 1);
      expect(split.hr).toBe(150);
    }
  });

  it("without samples, the whole run is its one effort", () => {
    const r = summarizeRun(
      { id: 1, date: "2026-10-01", distanceMeters: 10000, movingSeconds: 3000 },
      null
    );
    expect(r.efforts).toEqual([{ distanceMeters: 10000, seconds: 3000 }]);
    expect(r.splits).toEqual([]);
  });
});

describe("speedAtHr", () => {
  it("reads speed off the trend at the race heart rate", () => {
    // 1 bpm more buys 0.02 m/s: at 150 -> 3.0 m/s, at 160 -> 3.2.
    const splits = Array.from({ length: 12 }, (_, i) => ({
      hr: 140 + i * 2,
      speed: 2.8 + i * 0.04,
    }));
    expect(speedAtHr(splits, 154)!.speed).toBeCloseTo(3.08, 5);
  });

  it("averages the kilometres near it when heart rate barely varies", () => {
    const splits = Array.from({ length: 8 }, (_, i) => ({ hr: 152 + (i % 3), speed: 3.5 }));
    expect(speedAtHr(splits, 154)!.speed).toBeCloseTo(3.5, 5);
  });

  it("needs enough kilometres", () => {
    expect(speedAtHr([{ hr: 154, speed: 3.5 }], 154)).toBeNull();
  });
});

describe("predictAt", () => {
  const target: RaceTarget = { distanceMeters: 42195, goalSeconds: 11520, raceHr: 154 };

  it("averages the estimates it can make, from runs up to that day only", () => {
    const runs = [
      run("2026-09-01", 10, 250, 175), // a hard 10K
      run("2026-09-05", 12, 330, 140),
      run("2026-09-10", 14, 280, 154),
      run("2026-09-20", 14, 280, 154),
    ];
    const p = predictAt("2026-09-25", target, runs, [{ date: "2026-09-20", value: 52 }]);
    const kinds = p.estimates.map((e) => e.kind);
    expect(kinds).toEqual(["effort", "heartRate", "volume", "vo2max"]);
    expect(p.seconds).toBeCloseTo(p.estimates.reduce((s, e) => s + e.seconds, 0) / 4, 5);

    const effort = p.estimates[0];
    expect(effort.kind === "effort" && effort.effort.date).toBe("2026-09-01");
    const hr = p.estimates[1];
    expect(hr.kind === "heartRate" && hr.speed).toBeCloseTo(1000 / 280, 1);

    // A week before the 10K, nothing to go on but... nothing.
    expect(predictAt("2026-08-25", target, runs, []).seconds).toBeNull();
  });

  it("drops efforts and VO2max once they're too old", () => {
    const runs = [run("2026-06-01", 10, 250)];
    const p = predictAt("2026-09-25", target, runs, [{ date: "2026-08-01", value: 52 }]);
    expect(p.estimates).toEqual([]);
  });
});

describe("racePrediction", () => {
  it("adds one point a week, oldest first, ending today", () => {
    const target: RaceTarget = { distanceMeters: 42195, goalSeconds: null, raceHr: null };
    const runs = ["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15", "2026-10-01"].map((d) =>
      run(d, 12, 300)
    );
    const r = racePrediction(target, runs, [], "2026-10-16", "2026-09-07", "2026-11-01");
    expect(r.current.date).toBe("2026-10-16");
    const dates = r.history.map((h) => h.date);
    expect(dates[dates.length - 1]).toBe("2026-10-16");
    expect(dates[0]).toBe("2026-08-28"); // first point 3 weeks after the first run
    expect([...dates].sort()).toEqual(dates);
  });

  it("stops at race day once it's past", () => {
    const target: RaceTarget = { distanceMeters: 42195, goalSeconds: null, raceHr: null };
    const r = racePrediction(
      target,
      [run("2026-10-20", 12, 300)],
      [],
      "2026-12-01",
      "2026-09-07",
      "2026-11-01"
    );
    expect(r.current.date).toBe("2026-11-01");
  });
});
