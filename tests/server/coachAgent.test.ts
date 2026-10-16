import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CoachEvent } from "../../src/lib/coach.js";

// The Claude API, replaced by scripted replies: each call to stream() takes
// the next one and records the request it was given.
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
              if (!reply) throw new Error("No scripted reply left");
              const onText: ((d: string) => void)[] = [];
              return {
                on(event: string, fn: (d: string) => void) {
                  if (event === "text") onText.push(fn);
                  return this;
                },
                async finalMessage() {
                  for (const b of reply.content as { type: string; text?: string }[]) {
                    if (b.type === "text") onText.forEach((fn) => fn(b.text!));
                  }
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
    id: `msg_${api.replies.length}`,
    model: "claude-opus-5-5",
    role: "assistant",
    stop_reason: stopReason,
    content,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const PLAN = {
  version: "1.0",
  meta: {
    id: "race",
    event: "Race",
    eventDate: "2026-11-01",
    planStartDate: "2026-10-19",
    updatedAt: "x",
  },
  zones: {},
  raceStrategy: { event: { name: "Race", type: "Marathon", distances: { run: 42.195 } } },
  weeks: [
    {
      weekNumber: 1,
      startDate: "2026-10-19",
      endDate: "2026-10-25",
      phase: "Taper",
      focus: "",
      targetHours: 4,
      days: [
        {
          date: "2026-10-20",
          dayOfWeek: "Tuesday",
          workouts: [
            {
              id: "tempo",
              sport: "run",
              type: "tempo",
              name: "Tempo",
              description: "",
              durationMinutes: 50,
              completed: false,
            },
          ],
        },
        { date: "2026-10-21", dayOfWeek: "Wednesday", workouts: [] },
      ],
    },
  ],
};

describe("coach turn", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-coach-test-"));
  let userId: number;

  beforeAll(async () => {
    process.env.CLAUDE_COACH_DB_PATH = join(testDir, "test.db");
    process.env.ANTHROPIC_API_KEY = "test";
    const { initDatabase, run } = await import("../../src/db/client.js");
    const { migrate } = await import("../../src/db/migrate.js");
    await initDatabase();
    migrate();
    const { createUser } = await import("../../src/auth/users.js");
    userId = createUser("coach@example.com", "coach-password").id;
    run("INSERT INTO plans (id, user_id, event, event_date, data) VALUES (?, ?, ?, ?, ?)", [
      "race",
      userId,
      "Race",
      "2026-11-01",
      JSON.stringify(PLAN),
    ]);
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

  async function turn(text: string): Promise<CoachEvent[]> {
    const { runCoachTurn } = await import("../../src/lib/server/coach/agent.js");
    const events: CoachEvent[] = [];
    await runCoachTurn({
      userId,
      planId: "race",
      text,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    });
    return events;
  }

  it("reads, proposes, answers - and stores every message as returned", async () => {
    api.replies.push(
      reply("tool_use", [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "tool_use", id: "t1", name: "get_week", input: { weekNumber: 1 } },
      ]),
      reply("tool_use", [
        {
          type: "tool_use",
          id: "t2",
          name: "propose_plan_changes",
          input: {
            summary: "Move the tempo",
            changes: [
              { op: "move", workoutId: "tempo", date: "2026-10-21", reason: "Rest after Monday" },
            ],
          },
        },
      ]),
      reply("end_turn", [
        { type: "text", text: "Moved it to **Wednesday** - apply if that works." },
      ])
    );

    const events = await turn("Can I move Tuesday's tempo?");

    expect(events.map((e) => e.type)).toEqual(["activity", "activity", "proposal", "text", "done"]);
    const proposal = events.find((e) => e.type === "proposal");
    expect(proposal?.type === "proposal" && proposal.proposal.changes[0]).toMatchObject({
      op: "move",
      before: { date: "2026-10-20" },
      after: { date: "2026-10-21" },
    });

    // The week went back to the model as a tool result, with the plan's workout.
    const second = api.requests[1].messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    const toolResult = second[second.length - 1].content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(JSON.parse(toolResult.content as string).days[0].workouts[0].id).toBe("tempo");
    // The latest block carries the cache breakpoint; the thinking block came back untouched.
    expect(toolResult.cache_control).toEqual({ type: "ephemeral" });
    expect(second[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig-1" });
    expect(api.requests[0]).toMatchObject({ fallbacks: "default", thinking: { type: "adaptive" } });

    // The plan itself is untouched until the athlete applies.
    const { loadPlanForUser } = await import("../../src/lib/server/plans.js");
    expect(loadPlanForUser("race", userId)!.weeks[0].days[0].workouts[0].id).toBe("tempo");

    const { conversationView } = await import("../../src/lib/server/coach/store.js");
    const view = conversationView(userId, "race");
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[0].text).toBe("Can I move Tuesday's tempo?");
    expect(view.messages[1]).toMatchObject({
      text: "Moved it to **Wednesday** - apply if that works.",
      activity: ["get_week", "propose_plan_changes"],
      proposalIds: [view.proposals[0].id],
    });
  });

  it("tells the coach what the athlete did with its proposal", async () => {
    const { conversationView, setProposalStatus } =
      await import("../../src/lib/server/coach/store.js");
    const [proposal] = conversationView(userId, "race").proposals;
    setProposalStatus(proposal.id, "rejected");

    api.replies.push(reply("end_turn", [{ type: "text", text: "Fair enough." }]));
    await turn("Actually no.");
    const messages = api.requests[0].messages as { role: string; content: { text?: string }[] }[];
    const context = messages[messages.length - 1].content[0].text!;
    expect(context).toMatch(
      /^<app-context>Today is \w+ \d{4}-\d{2}-\d{2}\. The athlete rejected proposal #\d+ \(Move the tempo\)\.<\/app-context>$/
    );

    // Said once only.
    api.replies.push(reply("end_turn", [{ type: "text", text: "OK." }]));
    await turn("Thanks");
    const again = api.requests[1].messages as { content: { text?: string }[] }[];
    expect(again[again.length - 1].content[0].text).not.toMatch(/rejected/);
  });

  it("sends bad tool input back to the coach as an error", async () => {
    api.replies.push(
      reply("tool_use", [
        {
          type: "tool_use",
          id: "t3",
          name: "propose_plan_changes",
          input: { summary: "x", changes: [{ op: "delete", workoutId: "ghost", reason: "" }] },
        },
      ]),
      reply("end_turn", [{ type: "text", text: "Sorry, my mistake." }])
    );
    const events = await turn("Delete it");
    expect(events.some((e) => e.type === "proposal")).toBe(false);
    const messages = api.requests[1].messages as { content: Record<string, unknown>[] }[];
    expect(messages[messages.length - 1].content[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
      content: expect.stringMatching(/ghost not found/),
    });
  });

  it("answers a call left without result when a reply was interrupted", async () => {
    const { appendMessage, currentConversationId } =
      await import("../../src/lib/server/coach/store.js");
    appendMessage(currentConversationId(userId, "race"), "assistant", [
      { type: "tool_use", id: "lost", name: "get_plan_overview", input: {} },
    ]);
    api.replies.push(reply("end_turn", [{ type: "text", text: "Where were we?" }]));
    await turn("Hello again");
    const messages = api.requests[0].messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    const repair = messages[messages.length - 2];
    expect(repair.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "lost",
      is_error: true,
    });
  });

  it("starts a fresh conversation on request", async () => {
    const { conversationView, newConversation } =
      await import("../../src/lib/server/coach/store.js");
    newConversation(userId, "race");
    expect(conversationView(userId, "race")).toEqual({ messages: [], proposals: [] });
  });
});
