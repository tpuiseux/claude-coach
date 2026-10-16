import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const bridge = vi.hoisted(() => ({ details: vi.fn() }));
vi.mock("../../src/lib/server/garminBridge.js", () => ({
  fetchGarminActivityDetails: bridge.details,
}));

const SAMPLE = {
  series: { time: [0, 3, 6], speed: [2.9, 3.0, null], heartrate: [130, 140, 141], junk: [1] },
  laps: [{ distance: 1000, duration: 330, averageHR: 138, intensityType: "ACTIVE", extra: 1 }],
  complete: true,
};

describe("activity details", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-details-test-"));
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    process.env.CLAUDE_COACH_DB_PATH = join(testDir, "test.db");
    const { initDatabase, run } = await import("../../src/db/client.js");
    const { migrate } = await import("../../src/db/migrate.js");
    await initDatabase();
    migrate();
    const { createUser } = await import("../../src/auth/users.js");
    alice = createUser("alice@example.com", "alice-password").id;
    bob = createUser("bob@example.com", "bob-password").id;
    for (const [id, user] of [
      [1, alice],
      [2, alice],
      [3, alice],
    ]) {
      run(
        `INSERT INTO activities (id, user_id, sport_type, distance, moving_time, average_heartrate, raw_json)
         VALUES (?, ?, 'Run', 10000, 3000, 140, ?)`,
        [
          id,
          user,
          JSON.stringify({ aerobicTrainingEffect: 3.4, trainingEffectLabel: "AEROBIC_BASE" }),
        ]
      );
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_COACH_DB_PATH;
  });

  beforeEach(() => bridge.details.mockReset());

  it("fetches once from Garmin, then serves the cached copy", async () => {
    const { getActivityDetails } = await import("../../src/lib/server/activityDetails.js");
    bridge.details.mockResolvedValue({ ok: true, data: SAMPLE });

    const first = await getActivityDetails(alice, 1);
    const second = await getActivityDetails(alice, 1);
    expect(bridge.details).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("expected ok");
    expect(first.analysis.series).toEqual({
      time: [0, 3, 6],
      speed: [2.9, 3.0, null],
      heartrate: [130, 140, 141],
    });
    expect(first.analysis.laps).toEqual([
      { distance: 1000, duration: 330, averageHR: 138, intensityType: "ACTIVE" },
    ]);
    expect(first.analysis.stats.aerobicEffect).toBe(3.4);
    expect(first.analysis.stats.trainingEffectLabel).toBe("AEROBIC_BASE");
  });

  it("asks again while Garmin is still processing the upload, showing the partial copy meanwhile", async () => {
    const { getActivityDetails } = await import("../../src/lib/server/activityDetails.js");
    bridge.details.mockResolvedValue({ ok: true, data: { ...SAMPLE, complete: false } });
    await getActivityDetails(alice, 2);
    bridge.details.mockResolvedValue({ ok: false, status: 502, message: "down" });
    const result = await getActivityDetails(alice, 2);
    expect(bridge.details).toHaveBeenCalledTimes(2);
    if (!result.ok) throw new Error("expected ok");
    expect(result.analysis.series.heartrate).toEqual([130, 140, 141]);
    expect(result.analysis.detailsError).toBe("down");
  });

  it("still returns the summary when Garmin can't be reached", async () => {
    const { getActivityDetails } = await import("../../src/lib/server/activityDetails.js");
    bridge.details.mockResolvedValue({ ok: false, status: 502, message: "down" });
    const result = await getActivityDetails(alice, 3);
    if (!result.ok) throw new Error("expected ok");
    expect(result.analysis.series).toEqual({});
    expect(result.analysis.detailsError).toBe("down");
    expect(result.analysis.stats.distanceMeters).toBe(10000);
  });

  describe("prefetch after a sync", () => {
    it("fetches the newest activities without details first, up to the limit", async () => {
      const { run } = await import("../../src/db/client.js");
      const { prefetchActivityDetails } = await import("../../src/lib/server/activityDetails.js");
      for (const [id, date] of [
        [10, "2026-10-01T08:00:00"],
        [11, "2026-10-03T08:00:00"],
        [12, "2026-10-02T08:00:00"],
      ] as const) {
        run(
          "INSERT INTO activities (id, user_id, sport_type, start_date_local) VALUES (?, ?, 'Run', ?)",
          [id, bob, date]
        );
      }
      bridge.details.mockResolvedValue({ ok: true, data: SAMPLE });

      expect(await prefetchActivityDetails(bob, 2)).toBe(2);
      expect(bridge.details.mock.calls.map((c) => c[1])).toEqual([11, 12]);

      // Next sync: only what's left.
      bridge.details.mockClear();
      expect(await prefetchActivityDetails(bob, 2)).toBe(1);
      expect(bridge.details.mock.calls.map((c) => c[1])).toEqual([10]);
    });

    it("stops at the first failure, and gives up on an activity after 3 attempts", async () => {
      const { run } = await import("../../src/db/client.js");
      const { prefetchActivityDetails } = await import("../../src/lib/server/activityDetails.js");
      run(
        "INSERT INTO activities (id, user_id, sport_type, start_date_local) VALUES (20, ?, 'Run', '2026-10-10T08:00:00'), (21, ?, 'Run', '2026-10-09T08:00:00')",
        [bob, bob]
      );
      bridge.details.mockImplementation(async (_user: number, id: number) =>
        id === 20
          ? { ok: false, status: 502, message: "broken activity" }
          : { ok: true, data: SAMPLE }
      );

      for (let i = 0; i < 3; i++) expect(await prefetchActivityDetails(bob, 5)).toBe(0);
      expect(bridge.details.mock.calls.map((c) => c[1])).toEqual([20, 20, 20]);

      // Given up on 20: 21 gets its turn.
      expect(await prefetchActivityDetails(bob, 5)).toBe(1);
      expect(bridge.details).toHaveBeenLastCalledWith(bob, 21);
    });
  });

  it("never shows one athlete another's activity", async () => {
    const { getActivityDetails } = await import("../../src/lib/server/activityDetails.js");
    const result = await getActivityDetails(bob, 1);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(bridge.details).not.toHaveBeenCalled();
  });
});
