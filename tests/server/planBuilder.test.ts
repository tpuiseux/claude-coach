import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The Claude API, replaced by scripted replies (see coachAgent.test.ts).
const api = vi.hoisted(() => ({
  replies: [] as Record<string, unknown>[],
  requests: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const real = (await importOriginal()) as { default: new (opts: object) => object };
  class FakeAnthropic extends real.default {
    constructor() {
      super({ apiKey: "test" });
      Object.assign(this, {
        beta: {
          messages: {
            stream: (params: Record<string, unknown>) => {
              api.requests.push(structuredClone(params));
              const reply = api.replies.shift();
              return {
                on() {
                  return this;
                },
                async finalMessage() {
                  if (!reply) throw new Error("No scripted reply left");
                  return reply;
                },
              };
            },
          },
        },
      });
    }
  }
  return { ...real, default: FakeAnthropic };
});

function reply(stopReason: string, content: Record<string, unknown>[]) {
  return {
    id: "msg",
    model: "claude-opus-5-5",
    role: "assistant",
    stop_reason: stopReason,
    content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function call(name: string, input: Record<string, unknown>, id = name) {
  return reply("tool_use", [{ type: "tool_use", id, name, input }]);
}

const FORM = {
  raceName: "Semi de Test",
  raceDate: "2026-11-22",
  distance: "half",
  terrain: "road",
  goalTime: "1:35:00",
  startDate: "2026-11-02",
  availableDays: ["tuesday", "thursday", "sunday"],
  longRunDay: "sunday",
  runsPerWeek: 3,
  currentWeeklyKm: 30,
  longestRecentRunKm: 14,
  yearsRunning: 3,
  strength: false,
  units: "kilometers",
  language: "fr",
};

const ZONES = {
  run: {
    hr: {
      lthr: 175,
      zones: [1, 2, 3, 4].map((z) => ({
        zone: z,
        name: `Z${z}`,
        percentLow: 80 + z,
        percentHigh: 85 + z,
        hrLow: 130 + z * 10,
        hrHigh: 139 + z * 10,
      })),
    },
    pace: {
      thresholdPace: "4:20/km",
      thresholdPaceSeconds: 260,
      zones: ["E", "T", "I"].map((z, i) => ({
        zone: z,
        name: z,
        pace: "5:00/km",
        paceSeconds: 300 - i * 30,
      })),
    },
  },
};

const ASSESSMENT = {
  message: "Tu es prêt pour **1:35**.",
  goalTime: "1:35:00",
  assessment: { foundation: { raceHistory: [] }, currentForm: { weeklyVolume: { total: 3 } } },
  zones: ZONES,
  phases: [
    { name: "Build", startWeek: 1, endWeek: 2, focus: "Volume" },
    { name: "Taper", startWeek: 3, endWeek: 3, focus: "Fraîcheur" },
  ],
};

function week(n: number, start: string, extra: Record<string, unknown>[] = []) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), workouts: [] as Record<string, unknown>[] };
  });
  days[1].workouts.push({
    sport: "run",
    type: "tempo",
    name: "Tempo",
    durationMinutes: 50,
    structure: {
      warmup: [
        {
          type: "warmup",
          duration: { unit: "minutes", value: 15 },
          intensity: { unit: "pace_zone", value: 0 },
        },
      ],
      main: [
        {
          type: "work",
          duration: { unit: "minutes", value: 25 },
          intensity: { unit: "pace_zone", value: 0 },
        },
      ],
      cooldown: [
        {
          type: "cooldown",
          duration: { unit: "minutes", value: 10 },
          intensity: { unit: "pace_zone", value: 0 },
        },
      ],
    },
  });
  days[6].workouts.push(...extra);
  return {
    weekNumber: n,
    phase: n < 3 ? "Build" : "Taper",
    focus: "f",
    targetHours: 1,
    isRecoveryWeek: false,
    days,
  };
}

describe("plan builder", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-builder-test-"));
  let userId: number;

  beforeAll(async () => {
    process.env.CLAUDE_COACH_DB_PATH = join(testDir, "test.db");
    process.env.ANTHROPIC_API_KEY = "test";
    const { initDatabase } = await import("../../src/db/client.js");
    const { migrate } = await import("../../src/db/migrate.js");
    await initDatabase();
    migrate();
    const { createUser } = await import("../../src/auth/users.js");
    userId = createUser("builder@example.com", "builder-password").id;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_COACH_DB_PATH;
    delete process.env.ANTHROPIC_API_KEY;
  });

  beforeEach(() => {
    api.replies.length = 0;
    api.requests.length = 0;
  });

  /** Waits for the background job to stop. */
  async function settle(draftId: number) {
    const { isRunning } = await import("../../src/lib/server/planBuilder/builder.js");
    for (let i = 0; i < 200 && isRunning(draftId); i++) await new Promise((r) => setTimeout(r, 5));
  }

  async function draft(id: number) {
    const { getDraft } = await import("../../src/lib/server/planBuilder/store.js");
    return getDraft(userId, id)!;
  }

  it("validates the form and lays out the weeks", async () => {
    const { parsePlanForm, weekFrames } = await import("../../src/lib/server/planBuilder/form.js");
    const form = parsePlanForm(FORM, "2026-10-17");
    expect(form.availableDays).toEqual(["tuesday", "thursday", "sunday"]);
    const frames = weekFrames(form.startDate, form.raceDate);
    expect(frames.map((f) => [f.startDate, f.endDate])).toEqual([
      ["2026-11-02", "2026-11-08"],
      ["2026-11-09", "2026-11-15"],
      ["2026-11-16", "2026-11-22"],
    ]);
    expect(() => parsePlanForm({ ...FORM, startDate: "2026-11-03" }, "2026-10-17")).toThrow(
      /Monday/
    );
    expect(() => parsePlanForm({ ...FORM, raceDate: "2026-11-10" }, "2026-10-17")).toThrow(
      /3 to 30 weeks/
    );
    expect(() => parsePlanForm({ ...FORM, availableDays: ["monday"] }, "2026-10-17")).toThrow(
      /two days/
    );
  });

  it("assesses, takes changes, writes week by week, and adopts the plan", async () => {
    const { parsePlanForm } = await import("../../src/lib/server/planBuilder/form.js");
    const { createDraft } = await import("../../src/lib/server/planBuilder/store.js");
    const builder = await import("../../src/lib/server/planBuilder/builder.js");
    const id = createDraft(userId, parsePlanForm(FORM, "2026-10-17"));

    // 1. Assessment, then it waits.
    api.replies.push(
      call("get_training_history", {}),
      call(
        "submit_assessment",
        { ...ASSESSMENT, phases: [{ name: "x", startWeek: 1, endWeek: 1, focus: "" }] },
        "bad"
      ),
      call("submit_assessment", ASSESSMENT),
      reply("end_turn", [{ type: "text", text: "Done." }])
    );
    builder.startAssessment(id, userId, "Test");
    await settle(id);
    let d = await draft(id);
    expect(d.status).toBe("awaiting_confirmation");
    expect(d.assessment?.goalTime).toBe("1:35:00");
    // The bad phases went back to the coach.
    const bad = (api.requests[2].messages as { content: Record<string, unknown>[] }[]).at(-1)!
      .content[0];
    expect(bad).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/cover weeks 1 to 3/),
    });
    // The athlete's answers opened the conversation.
    expect((api.requests[0].messages as { content: string }[])[0].content).toMatch(
      /Semi de Test.*21\.0975 km/
    );

    // 2. Changes asked, a revised assessment.
    api.replies.push(
      call("submit_assessment", { ...ASSESSMENT, goalTime: "1:37:00" }),
      reply("end_turn", [])
    );
    builder.sendFeedback(d, "Plutôt 1:37");
    await settle(id);
    d = await draft(id);
    expect(d.status).toBe("awaiting_confirmation");
    expect(d.assessment?.goalTime).toBe("1:37:00");

    // 3. Confirmed: weeks, one refused and fixed, a stop mid-way nudged, then finish.
    const raceDay = { sport: "race", type: "race", name: "Semi", durationMinutes: 97 };
    const wrong = week(1, "2026-11-02");
    (wrong.days[1].workouts[0] as { durationMinutes: number }).durationMinutes = 90;
    api.replies.push(
      call("write_week", wrong, "w1-bad"),
      call("write_week", week(1, "2026-11-02"), "w1"),
      call("write_week", week(2, "2026-11-09"), "w2"),
      reply("end_turn", []),
      call(
        "finish_plan",
        { raceStrategy: { pacing: { run: {} }, nutrition: {}, taper: {} } },
        "early"
      ),
      call("write_week", week(3, "2026-11-16", [raceDay]), "w3"),
      call("finish_plan", {
        raceStrategy: { pacing: { run: { targetPace: "4:36/km" } }, nutrition: {}, taper: {} },
      }),
      reply("end_turn", [])
    );
    builder.confirmAssessment(d);
    await settle(id);
    d = await draft(id);
    expect(d.status).toBe("ready");
    const results = (n: number) =>
      (api.requests[n].messages as { content: Record<string, unknown>[] | string }[]).at(-1)!
        .content;
    // Requests 0-5 were the assessment's; the plan's start at 6.
    expect(results(7)).toMatchObject([
      { is_error: true, content: expect.stringMatching(/adds up to 50 min/) },
    ]);
    expect(results(8)[0]).toMatchObject({ content: expect.stringMatching(/"next":"week 2/) });
    expect(results(10)).toMatch(/Keep going: write week 3/);
    expect(results(11)).toMatchObject([{ is_error: true, content: "Week 3 isn't written yet." }]);
    expect(d.weeks[1].days[1].workouts[0]).toMatchObject({ id: "w1-tue-run", completed: false });
    expect(d.weeks[1].summary).toEqual({
      totalHours: 0.8,
      bySport: { run: { sessions: 1, hours: 0.8 } },
    });

    // 4. Adopted: a plan the app can read, with the goal for the race prediction.
    const planId = builder.adopt(d, "Test");
    const { loadPlanForUser } = await import("../../src/lib/server/plans.js");
    const plan = loadPlanForUser(planId, userId)!;
    expect(planId).toBe(`semi-de-test-2026-11-22-${id}`);
    expect(plan.meta).toMatchObject({
      planStartDate: "2026-11-02",
      totalWeeks: 3,
      event: "Semi de Test",
    });
    expect(plan.weeks.map((w) => w.weekNumber)).toEqual([1, 2, 3]);
    const { raceTarget } = await import("../../src/lib/racePrediction.js");
    expect(raceTarget(plan)).toMatchObject({ distanceMeters: 21097.5, goalSeconds: 97 * 60 });
    const { deriveSettingsFromPlan } = await import("../../src/lib/settings.js");
    expect(deriveSettingsFromPlan(plan).run.lthr).toBe(175);
    expect((await draft(id)).status).toBe("adopted");
  });

  it("marks a job cut short as failed, and carries on from there on retry", async () => {
    const { parsePlanForm } = await import("../../src/lib/server/planBuilder/form.js");
    const { createDraft, appendDraftMessages } =
      await import("../../src/lib/server/planBuilder/store.js");
    const builder = await import("../../src/lib/server/planBuilder/builder.js");
    const id = createDraft(userId, parsePlanForm(FORM, "2026-10-17"));
    // As if the server died right after the coach asked for a tool.
    appendDraftMessages(id, [
      { role: "user", content: "form" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "lost", name: "get_training_history", input: {} }],
      },
    ]);
    const view = builder.draftView(await draft(id));
    expect(view).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });

    api.replies.push(call("submit_assessment", ASSESSMENT), reply("end_turn", []));
    builder.retry(await draft(id));
    await settle(id);
    expect((await draft(id)).status).toBe("awaiting_confirmation");
    const messages = api.requests[0].messages as {
      role: string;
      content: Record<string, unknown>[] | string;
    }[];
    expect(messages[2].content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "lost", is_error: true }),
    ]);
    expect(messages[3].content).toMatch(/Carry on/);
  });
});
