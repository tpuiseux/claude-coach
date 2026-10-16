import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The bridge is the only thing that talks to Garmin; here it's a fake whose
// responses each test sets.
const bridge = vi.hoisted(() => ({
  activities: vi.fn(),
  wellness: vi.fn(),
}));
vi.mock("../../src/lib/server/garminBridge.js", () => ({
  fetchGarminActivities: bridge.activities,
  fetchGarminWellness: bridge.wellness,
  // Curves and laps fetched after each sync - covered in activityDetails.test.ts.
  fetchGarminActivityDetails: async () => ({ ok: false, status: 503, message: "not in this test" }),
}));

function activity(id: number, local: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Activity ${id}`,
    sport_type: "Run",
    start_date: `${local}Z`,
    start_date_local: local,
    moving_time: 3000,
    distance: 10000,
    average_heartrate: 145,
    raw_json: "{}",
    ...extra,
  };
}

async function waitForSync(userId: number) {
  const { isSyncRunning } = await import("../../src/lib/server/garminSync.js");
  for (let i = 0; i < 100 && isSyncRunning(userId); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("training log (Garmin sync + workout feedback)", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-traininglog-test-"));
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    process.env.CLAUDE_COACH_DB_PATH = join(testDir, "test.db");
    const { initDatabase } = await import("../../src/db/client.js");
    const { migrate } = await import("../../src/db/migrate.js");
    await initDatabase();
    migrate();
    const { createUser } = await import("../../src/auth/users.js");
    const { markGarminConnected } = await import("../../src/lib/server/garminCredentials.js");
    alice = createUser("alice@example.com", "alice-password").id;
    bob = createUser("bob@example.com", "bob-password").id;
    markGarminConnected(alice);
    markGarminConnected(bob);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_COACH_DB_PATH;
  });

  beforeEach(() => {
    bridge.activities.mockReset();
    bridge.wellness.mockReset();
    bridge.wellness.mockResolvedValue({ ok: true, data: { days: [] } });
  });

  describe("syncRange", () => {
    it("looks back six weeks on the first sync, and from the last one (minus overlap) after", async () => {
      const { syncRange } = await import("../../src/lib/server/garminSync.js");
      const now = Date.parse("2026-10-15T08:00:00Z");
      expect(syncRange(null, 42, 120, now)).toEqual({ start: "2026-09-04", end: "2026-10-15" });
      expect(syncRange("2026-10-14T20:00:00Z", 42, 120, now)).toEqual({
        start: "2026-10-12",
        end: "2026-10-15",
      });
      // A sync months ago is capped to what the bridge accepts in one request.
      expect(syncRange("2026-01-01T00:00:00Z", 14, 31, now)).toEqual({
        start: "2026-09-15",
        end: "2026-10-15",
      });
    });
  });

  describe("sync", () => {
    it("stores activities and wellness for the user, and records success", async () => {
      const { startGarminSync, getSyncState } = await import("../../src/lib/server/garminSync.js");
      const { getActivitiesByDate } = await import("../../src/lib/server/activities.js");
      const { get } = await import("../../src/db/client.js");

      const today = new Date().toISOString().slice(0, 10);
      bridge.activities.mockResolvedValue({
        ok: true,
        data: { activities: [activity(9001, `${today}T07:00:00`)], duplicatesRemoved: 0 },
      });
      bridge.wellness.mockResolvedValue({
        ok: true,
        data: { days: [{ date: today, sleep_score: 81, hrv_last_night_avg: 62, bogus_column: 1 }] },
      });

      expect(startGarminSync(alice)).toBe("started");
      expect(startGarminSync(alice)).toBe("running");
      await waitForSync(alice);

      const state = getSyncState(alice)!;
      expect(state.status).toBe("success");
      expect(state.activities_synced).toBe(1);
      expect(state.wellness_days_synced).toBe(1);

      expect(getActivitiesByDate(alice, today, today)[today]?.map((a) => a.id)).toEqual([9001]);
      expect(getActivitiesByDate(bob, today, today)).toEqual({});
      expect(
        get<{ sleep_score: number }>(
          "SELECT sleep_score FROM daily_wellness WHERE user_id = ? AND date = ?",
          [alice, today]
        )?.sleep_score
      ).toBe(81);

      // Fresh now: a non-forced call is a no-op.
      expect(startGarminSync(alice)).toBe("fresh");
    });

    it("drops activities deleted on Garmin within the synced window", async () => {
      const { startGarminSync } = await import("../../src/lib/server/garminSync.js");
      const { getActivitiesByDate } = await import("../../src/lib/server/activities.js");
      const today = new Date().toISOString().slice(0, 10);

      bridge.activities.mockResolvedValue({
        ok: true,
        data: { activities: [activity(9002, `${today}T18:00:00`)], duplicatesRemoved: 0 },
      });
      startGarminSync(alice, { force: true });
      await waitForSync(alice);

      // 9001 (synced in the previous test) is gone from Garmin's answer.
      expect(getActivitiesByDate(alice, today, today)[today]?.map((a) => a.id)).toEqual([9002]);
    });

    it("never overwrites another user's activity", async () => {
      const { startGarminSync } = await import("../../src/lib/server/garminSync.js");
      const { get } = await import("../../src/db/client.js");
      const today = new Date().toISOString().slice(0, 10);

      bridge.activities.mockResolvedValue({
        ok: true,
        data: {
          activities: [activity(9002, `${today}T18:00:00`, { name: "Bob's hijack" })],
          duplicatesRemoved: 0,
        },
      });
      startGarminSync(bob, { force: true });
      await waitForSync(bob);

      const row = get<{ user_id: number; name: string }>(
        "SELECT user_id, name FROM activities WHERE id = 9002"
      );
      expect(row).toEqual({ user_id: alice, name: "Activity 9002" });
    });

    it("records a failure, keeping the previous success time", async () => {
      const { startGarminSync, getSyncState } = await import("../../src/lib/server/garminSync.js");
      const before = getSyncState(alice)!.last_success_at;

      bridge.activities.mockResolvedValue({ ok: false, status: 429, message: "Garmin limite" });
      startGarminSync(alice, { force: true });
      await waitForSync(alice);

      const state = getSyncState(alice)!;
      expect(state.status).toBe("failed");
      expect(state.error).toBe("Garmin limite");
      expect(state.last_success_at).toBe(before);
    });

    it("does nothing for an account that isn't connected to Garmin", async () => {
      const { startGarminSync } = await import("../../src/lib/server/garminSync.js");
      const { createUser } = await import("../../src/auth/users.js");
      const carol = createUser("carol@example.com", "carol-password").id;
      expect(startGarminSync(carol, { force: true })).toBe("not-connected");
      expect(bridge.activities).not.toHaveBeenCalled();
    });

    it("treats a sync older than 6 hours as stale", async () => {
      const { isSyncStale } = await import("../../src/lib/server/garminSync.js");
      const now = Date.now();
      const state = (agoMs: number) => ({
        status: "success" as const,
        started_at: "",
        finished_at: null,
        last_success_at: new Date(now - agoMs).toISOString(),
        activities_synced: 0,
        wellness_days_synced: 0,
        error: null,
      });
      expect(isSyncStale(null, now)).toBe(true);
      expect(isSyncStale(state(5 * 60 * 60 * 1000), now)).toBe(false);
      expect(isSyncStale(state(7 * 60 * 60 * 1000), now)).toBe(true);
    });
  });

  describe("activities by local date", () => {
    it("files an activity under its local date, not its UTC one", async () => {
      const { run } = await import("../../src/db/client.js");
      const { getActivitiesByDate } = await import("../../src/lib/server/activities.js");
      // 00:30 local on the 3rd is still the 2nd in UTC.
      run(
        `INSERT INTO activities (id, name, sport_type, start_date, start_date_local, user_id)
         VALUES (7001, 'Midnight run', 'Run', '2026-03-02T22:30:00Z', '2026-03-03T00:30:00', ?)`,
        [alice]
      );
      const byDate = getActivitiesByDate(alice, "2026-03-01", "2026-03-03");
      expect(Object.keys(byDate)).toEqual(["2026-03-03"]);
    });
  });

  describe("workout feedback", () => {
    it("validates input", async () => {
      const { parseWorkoutFeedback, ValidationError } =
        await import("../../src/lib/server/validation.js");
      expect(parseWorkoutFeedback({ rpe: 7, feeling: "hard" })).toEqual({
        rpe: 7,
        feeling: "hard",
        pain: false,
        painNotes: null,
        notes: null,
      });
      // pain notes only count when pain is reported
      expect(parseWorkoutFeedback({ notes: " ok ", painNotes: "calf" }).painNotes).toBeNull();
      expect(parseWorkoutFeedback({ pain: true, painNotes: " left calf " }).painNotes).toBe(
        "left calf"
      );

      for (const bad of [
        {},
        { notes: "   " },
        { rpe: 0 },
        { rpe: 11 },
        { rpe: 6.5 },
        { rpe: "7" },
        { feeling: "meh" },
        { pain: "yes" },
        { notes: "x".repeat(2001) },
        null,
      ]) {
        expect(() => parseWorkoutFeedback(bad)).toThrow(ValidationError);
      }
    });

    it("saves, updates and deletes per user and plan", async () => {
      const { saveFeedback, getFeedbackForPlan, deleteFeedback } =
        await import("../../src/lib/server/feedback.js");
      const input = { rpe: 6, feeling: "good" as const, pain: false, painNotes: null, notes: null };

      saveFeedback(alice, "plan-a", "w1", input);
      saveFeedback(alice, "plan-a", "w1", { ...input, rpe: 8, pain: true, painNotes: "knee" });

      const feedback = getFeedbackForPlan(alice, "plan-a");
      expect(Object.keys(feedback)).toEqual(["w1"]);
      expect(feedback.w1).toMatchObject({ rpe: 8, pain: true, painNotes: "knee", feeling: "good" });

      // Isolated by user and by plan.
      expect(getFeedbackForPlan(bob, "plan-a")).toEqual({});
      expect(getFeedbackForPlan(alice, "plan-b")).toEqual({});

      deleteFeedback(alice, "plan-a", "w1");
      expect(getFeedbackForPlan(alice, "plan-a")).toEqual({});
    });
  });

  describe("auto-completion from matched activities", () => {
    const planId = "auto-plan";
    const plan = () => ({
      meta: {
        id: planId,
        event: "Test 10K",
        eventDate: "2026-05-31",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
      weeks: [
        {
          weekNumber: 1,
          days: [
            {
              date: "2026-05-04",
              dayOfWeek: "Monday",
              workouts: [
                {
                  id: "w-run",
                  sport: "run",
                  type: "endurance",
                  name: "Easy",
                  description: "",
                  completed: false,
                },
                {
                  id: "w-gym",
                  sport: "strength",
                  type: "endurance",
                  name: "Gym",
                  description: "",
                  completed: false,
                },
              ],
            },
            {
              date: "2026-05-05",
              dayOfWeek: "Tuesday",
              workouts: [
                {
                  id: "w-rest",
                  sport: "rest",
                  type: "rest",
                  name: "Rest",
                  description: "",
                  completed: false,
                },
              ],
            },
          ],
        },
      ],
    });

    const completedIds = async () => {
      const { loadPlanForUser } = await import("../../src/lib/server/plans.js");
      return loadPlanForUser(planId, alice)!
        .weeks.flatMap((w) => w.days)
        .flatMap((d) => d.workouts)
        .filter((w) => w.completed)
        .map((w) => w.id);
    };

    beforeAll(async () => {
      const { importPlanForUser } = await import("../../src/lib/server/plans.js");
      const { run } = await import("../../src/db/client.js");
      importPlanForUser(alice, plan() as never);
      run(
        `INSERT INTO activities (id, name, sport_type, start_date, start_date_local, user_id) VALUES
           (8001, 'Morning run', 'Run', '2026-05-04T05:00:00Z', '2026-05-04T07:00:00', ?),
           (8002, 'Rest-day ride', 'Ride', '2026-05-05T08:00:00Z', '2026-05-05T10:00:00', ?)`,
        [alice, alice]
      );
    });

    it("ticks the matched workout only", async () => {
      const { autoCompleteFromActivities } = await import("../../src/lib/server/autoComplete.js");
      expect(autoCompleteFromActivities(alice, [planId])).toBe(1);
      // the run matched; no gym session recorded; the ride was on a rest day
      expect(await completedIds()).toEqual(["w-run"]);
    });

    it("doesn't re-tick a workout the athlete unticked", async () => {
      const { autoCompleteFromActivities } = await import("../../src/lib/server/autoComplete.js");
      const { loadPlanForUser, savePlanForUser } = await import("../../src/lib/server/plans.js");
      const { setWorkoutCompleted } = await import("../../src/lib/server/planMutations.js");

      const p = loadPlanForUser(planId, alice)!;
      setWorkoutCompleted(p, "w-run", false);
      savePlanForUser(planId, alice, p);

      expect(autoCompleteFromActivities(alice, [planId])).toBe(0);
      expect(await completedIds()).toEqual([]);
    });

    it("starts over after a re-import", async () => {
      const { autoCompleteFromActivities, resetAutoCompletions } =
        await import("../../src/lib/server/autoComplete.js");
      resetAutoCompletions(alice, planId);
      expect(autoCompleteFromActivities(alice, [planId])).toBe(1);
      expect(await completedIds()).toEqual(["w-run"]);
    });

    it("only ever touches the user's own plans", async () => {
      const { autoCompleteFromActivities } = await import("../../src/lib/server/autoComplete.js");
      // Bob has no plans, and can't reach Alice's by id.
      expect(autoCompleteFromActivities(bob)).toBe(0);
      expect(autoCompleteFromActivities(bob, [planId])).toBe(0);
      expect(await completedIds()).toEqual(["w-run"]);
    });
  });
});
