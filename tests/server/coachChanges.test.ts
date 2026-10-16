import { describe, it, expect } from "vitest";
import {
  applyPlanChanges,
  parsePlanChanges,
  parseStructure,
} from "../../src/lib/server/coach/changes.js";
import { renderMarkdown } from "../../src/lib/markdown.js";
import type { TrainingPlan } from "../../src/schema/training-plan.js";

const STRUCTURE = {
  warmup: [
    {
      type: "warmup",
      duration: { unit: "minutes", value: 15 },
      intensity: { unit: "pace_zone", value: 0, valueLow: 328, valueHigh: 355, description: "E" },
    },
  ],
  main: [
    {
      type: "interval_set",
      repeats: 3,
      steps: [
        {
          type: "work",
          duration: { unit: "minutes", value: 6 },
          intensity: { unit: "rpe", value: 7 },
        },
        {
          type: "recovery",
          duration: { unit: "minutes", value: 2 },
          intensity: { unit: "rpe", value: 3 },
        },
      ],
    },
  ],
};

function plan(): TrainingPlan {
  return {
    meta: { id: "p", updatedAt: "2026-01-01T00:00:00Z" },
    weeks: [
      {
        weekNumber: 1,
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        days: [
          {
            date: "2026-10-20",
            dayOfWeek: "Tuesday",
            workouts: [
              {
                id: "tempo",
                sport: "run",
                type: "tempo",
                name: "3x6' Tempo",
                description: "",
                durationMinutes: 50,
                structure: STRUCTURE,
                completed: false,
              },
              {
                id: "done",
                sport: "run",
                type: "endurance",
                name: "Easy",
                description: "",
                completed: true,
              },
            ],
          },
          { date: "2026-10-21", dayOfWeek: "Wednesday", workouts: [] },
        ],
      },
    ],
  } as unknown as TrainingPlan;
}

describe("parsePlanChanges", () => {
  it("keeps valid changes and the app's field rules", () => {
    const changes = parsePlanChanges([
      { op: "move", workoutId: "tempo", date: "2026-10-21", reason: "rest day before" },
      {
        op: "edit",
        workoutId: "tempo",
        updates: { durationMinutes: 40, structure: STRUCTURE },
        reason: "",
      },
      {
        op: "add",
        date: "2026-10-21",
        workout: { sport: "run", type: "recovery", name: "Shakeout" },
        reason: "",
      },
      { op: "delete", workoutId: "tempo", reason: "" },
    ]);
    expect(changes.map((c) => c.op)).toEqual(["move", "edit", "add", "delete"]);
  });

  it("rejects what the app would reject, saying where", () => {
    expect(() => parsePlanChanges([])).toThrow(/non-empty/);
    expect(() => parsePlanChanges([{ op: "move", workoutId: "tempo", date: "tomorrow" }])).toThrow(
      /changes\[0\]: date/
    );
    expect(() =>
      parsePlanChanges([{ op: "edit", workoutId: "tempo", updates: { completed: true } }])
    ).toThrow(/cannot be edited/);
    expect(() =>
      parsePlanChanges([{ op: "add", date: "2026-10-21", workout: { name: "No sport" } }])
    ).toThrow(/required/);
    expect(() => parsePlanChanges([{ op: "rename" }])).toThrow(/op must be/);
  });

  it("validates workout structure", () => {
    expect(parseStructure(STRUCTURE).main).toHaveLength(1);
    expect(() => parseStructure({ main: [] })).toThrow(/non-empty/);
    expect(() =>
      parseStructure({
        main: [
          {
            type: "sprint",
            duration: { unit: "minutes", value: 1 },
            intensity: { unit: "rpe", value: 9 },
          },
        ],
      })
    ).toThrow(/type must be/);
    expect(() =>
      parseStructure({ main: [{ type: "interval_set", repeats: 0, steps: [] }] })
    ).toThrow(/repeats/);
  });
});

describe("applyPlanChanges", () => {
  it("applies in order and describes each change", () => {
    const p = plan();
    const preview = applyPlanChanges(
      p,
      parsePlanChanges([
        { op: "move", workoutId: "tempo", date: "2026-10-21", reason: "r" },
        {
          op: "add",
          date: "2026-10-20",
          workout: { sport: "run", type: "recovery", name: "Shakeout", durationMinutes: 20 },
          reason: "",
        },
      ])
    );
    const [tue, wed] = p.weeks[0].days;
    expect(wed.workouts.map((w) => w.id)).toEqual(["tempo"]);
    expect(tue.workouts.map((w) => w.name)).toEqual(["Easy", "Shakeout"]);
    expect(tue.workouts[1].id).toMatch(/^coach-/);
    expect(preview[0]).toMatchObject({
      op: "move",
      before: { date: "2026-10-20", name: "3x6' Tempo", durationMinutes: 50 },
      after: { date: "2026-10-21" },
      reason: "r",
    });
    expect(preview[1]).toMatchObject({ op: "add", before: null, after: { name: "Shakeout" } });
  });

  it("drops stale export steps when a session's content changes without new ones", () => {
    const p = plan();
    applyPlanChanges(
      p,
      parsePlanChanges([
        { op: "edit", workoutId: "tempo", updates: { durationMinutes: 30 }, reason: "" },
      ])
    );
    expect(p.weeks[0].days[0].workouts[0].structure).toBeUndefined();

    const q = plan();
    applyPlanChanges(
      q,
      parsePlanChanges([
        { op: "edit", workoutId: "tempo", updates: { notes: "go easy" }, reason: "" },
      ])
    );
    expect(q.weeks[0].days[0].workouts[0].structure).toBeDefined();
  });

  it("leaves completed workouts alone and fails whole", () => {
    const p = plan();
    expect(() =>
      applyPlanChanges(
        p,
        parsePlanChanges([
          { op: "move", workoutId: "tempo", date: "2026-10-21", reason: "" },
          { op: "delete", workoutId: "done", reason: "" },
        ])
      )
    ).toThrow(/changes\[1\]: .*completed/);
    expect(() =>
      applyPlanChanges(plan(), parsePlanChanges([{ op: "delete", workoutId: "nope", reason: "" }]))
    ).toThrow(/not found/);
    expect(() =>
      applyPlanChanges(
        plan(),
        parsePlanChanges([{ op: "move", workoutId: "tempo", date: "2027-01-01", reason: "" }])
      )
    ).toThrow(/No day/);
  });
});

describe("renderMarkdown", () => {
  it("renders the basics", () => {
    expect(renderMarkdown("Hi **there**,\nsecond line\n\n- one\n- *two*\n\n1. a\n2. `b`")).toBe(
      "<p>Hi <strong>there</strong>,<br>second line</p><ul><li>one</li><li><em>two</em></li></ul><ol><li>a</li><li><code>b</code></li></ol>"
    );
  });

  it("escapes HTML", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>"
    );
  });

  it("leaves paces and multiplications alone", () => {
    expect(renderMarkdown("3*6' at 4:17/km, 2 * 3")).toBe("<p>3*6&#39; at 4:17/km, 2 * 3</p>");
  });
});
