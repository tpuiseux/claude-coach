import { describe, it, expect } from "vitest";
import { reviewWeek, type WellnessDay } from "../../src/lib/weekReview.js";
import type { TrainingWeek } from "../../src/schema/training-plan.js";
import type { RecordedActivity, WorkoutFeedback } from "../../src/lib/trainingLog.js";

const WEEK = {
  weekNumber: 6,
  startDate: "2026-10-12",
  endDate: "2026-10-18",
  summary: { totalHours: 5, bySport: { run: { sessions: 3, hours: 4, km: 45 } } },
  days: [
    {
      date: "2026-10-13",
      dayOfWeek: "Tuesday",
      workouts: [
        {
          id: "tempo",
          sport: "run",
          type: "tempo",
          name: "Tempo",
          durationMinutes: 60,
          completed: false,
        },
      ],
    },
    {
      date: "2026-10-15",
      dayOfWeek: "Thursday",
      workouts: [
        {
          id: "easy",
          sport: "run",
          type: "endurance",
          name: "Easy",
          durationMinutes: 60,
          completed: false,
        },
        {
          id: "str",
          sport: "strength",
          type: "endurance",
          name: "Strength",
          durationMinutes: 20,
          completed: false,
        },
      ],
    },
    {
      date: "2026-10-18",
      dayOfWeek: "Sunday",
      workouts: [
        {
          id: "long",
          sport: "run",
          type: "long",
          name: "Long Run",
          durationMinutes: 120,
          completed: false,
        },
        { id: "rest", sport: "rest", type: "rest", name: "Rest", completed: false },
      ],
    },
  ],
} as unknown as TrainingWeek;

function run(id: number, date: string, km: number, minutes: number, hr: number): RecordedActivity {
  return {
    id,
    name: null,
    sportType: "Run",
    startLocal: `${date}T08:00:00`,
    movingSeconds: minutes * 60,
    distanceMeters: km * 1000,
    averageHeartrate: hr,
  };
}

const ACTIVITIES = {
  "2026-10-13": [run(1, "2026-10-13", 12, 60, 158)],
  "2026-10-15": [run(2, "2026-10-15", 10, 60, 150)],
  "2026-10-18": [run(3, "2026-10-18", 20, 120, 156)],
};

const ZONES = [
  { zone: 1, name: "Recovery", low: 0, high: 142 },
  { zone: 2, name: "Aerobic", low: 143, high: 157 },
];

function feedback(
  workoutId: string,
  rpe: number,
  painNotes: string | null = null
): WorkoutFeedback {
  return {
    workoutId,
    rpe,
    feeling: "ok",
    pain: painNotes !== null,
    painNotes,
    notes: null,
    updatedAt: "",
  };
}

function wellness(date: string, extra: Partial<WellnessDay> = {}): WellnessDay {
  return {
    date,
    sleep_score: 80,
    resting_hr: 48,
    hrv_status: "BALANCED",
    training_readiness_score: 70,
    acwr: 1.1,
    ...extra,
  };
}

describe("reviewWeek", () => {
  it("compares the finished week with the plan", () => {
    const r = reviewWeek(
      WEEK,
      "2026-10-20",
      ACTIVITIES,
      { tempo: feedback("tempo", 7), long: feedback("long", 6, "ischio") },
      [wellness("2026-10-13"), wellness("2026-10-14", { sleep_score: 70 }), wellness("2026-10-11")],
      ZONES
    );
    expect(r.inProgress).toBe(false);
    // Rest days don't count; strength had nothing recorded.
    expect(r.sessions).toEqual({ planned: 4, done: 3 });
    expect(r.missed).toEqual(["Strength"]);
    expect(r.minutes).toEqual({ planned: 260, actual: 240 });
    expect(r.runKm).toEqual({ planned: 45, actual: 42 });
    // Easy and long runs, time-weighted: (150*60 + 156*120) / 180 = 154.
    expect(r.easyRuns).toEqual({ count: 2, pace: 360, heartrate: 154 });
    expect(r.feedback).toEqual({ count: 2, averageRpe: 6.5, pain: ["ischio"] });
    expect(r.recovery).toMatchObject({ sleepScore: 75, hrvLowDays: 0, acwr: 1.1 });
    expect(r.flags.map((f) => f.text)).toEqual(["1 missed", "Pain reported"]);
  });

  it("doesn't call a session missed before its day, and flags warning signs", () => {
    const r = reviewWeek(
      WEEK,
      "2026-10-15",
      { "2026-10-13": ACTIVITIES["2026-10-13"], "2026-10-15": [run(2, "2026-10-15", 10, 60, 160)] },
      {},
      ["2026-10-12", "2026-10-13", "2026-10-14"].map((d) =>
        wellness(d, { hrv_status: "LOW", sleep_score: 55, acwr: 1.7 })
      ),
      ZONES
    );
    expect(r.inProgress).toBe(true);
    // Thursday's strength is today, Sunday's long run is ahead: not missed yet.
    expect(r.missed).toEqual([]);
    expect(r.flags.map((f) => f.text)).toEqual([
      "Easy runs above zone 2 (160 bpm)",
      "Load ramping fast (ACWR 1.7)",
      "HRV low 3 days",
      "Poor sleep (score 55)",
    ]);
  });
});
