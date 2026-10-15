import { describe, it, expect } from "vitest";
import { matchDay, type RecordedActivity } from "../../src/lib/trainingLog.js";
import type { Sport, Workout } from "../../src/schema/training-plan.js";

const workout = (id: string, sport: Sport): Workout =>
  ({ id, sport, type: "endurance", name: id, description: "", completed: false }) as Workout;

const activity = (id: number, sportType: string, time: string): RecordedActivity => ({
  id,
  name: `${sportType} ${id}`,
  sportType,
  startLocal: `2026-10-15T${time}:00`,
  movingSeconds: 3000,
  distanceMeters: 10000,
  averageHeartrate: 140,
});

const ids = (activities: RecordedActivity[] | undefined) => (activities ?? []).map((a) => a.id);

describe("matchDay", () => {
  it("attaches a recorded run to the planned run", () => {
    const m = matchDay([workout("run", "run")], [activity(1, "Run", "07:00")]);
    expect(ids(m.byWorkout.run)).toEqual([1]);
    expect(m.unplanned).toEqual([]);
  });

  it("treats trail runs and gravel rides as their sport", () => {
    const m = matchDay(
      [workout("run", "run"), workout("bike", "bike")],
      [activity(1, "TrailRun", "07:00"), activity(2, "GravelRide", "17:00")]
    );
    expect(ids(m.byWorkout.run)).toEqual([1]);
    expect(ids(m.byWorkout.bike)).toEqual([2]);
  });

  it("pairs same-sport sessions in the day's order, and leaves an extra one unplanned", () => {
    const m = matchDay(
      [workout("am-run", "run"), workout("pm-run", "run")],
      // given out of order on purpose
      [activity(3, "Run", "21:00"), activity(1, "Run", "06:30"), activity(2, "Run", "18:00")]
    );
    expect(ids(m.byWorkout["am-run"])).toEqual([1]);
    expect(ids(m.byWorkout["pm-run"])).toEqual([2]);
    expect(ids(m.unplanned)).toEqual([3]);
  });

  it("gives a brick both its bike and its run, but not a second bike", () => {
    const m = matchDay(
      [workout("brick", "brick")],
      [activity(1, "Ride", "08:00"), activity(2, "Run", "09:30"), activity(3, "Ride", "18:00")]
    );
    expect(ids(m.byWorkout.brick)).toEqual([1, 2]);
    expect(ids(m.unplanned)).toEqual([3]);
  });

  it("matches a race in any discipline", () => {
    const m = matchDay([workout("race", "race")], [activity(1, "Run", "09:00")]);
    expect(ids(m.byWorkout.race)).toEqual([1]);
  });

  it("never matches a rest day: anything recorded on it is unplanned", () => {
    const m = matchDay([workout("rest", "rest")], [activity(1, "Ride", "10:00")]);
    expect(m.byWorkout).toEqual({});
    expect(ids(m.unplanned)).toEqual([1]);
  });

  it("leaves sports the plan doesn't have that day, or doesn't know, unplanned", () => {
    const m = matchDay(
      [workout("run", "run")],
      [activity(1, "Swim", "07:00"), activity(2, "Badminton", "19:00")]
    );
    expect(m.byWorkout).toEqual({});
    expect(ids(m.unplanned)).toEqual([1, 2]);
  });

  it("falls back to a workout naming the sport, even one filed under rest", () => {
    const m = matchDay(
      [workout("Badminton (Cross-Training)", "rest")],
      [activity(1, "Badminton", "19:00"), activity(2, "Badminton", "21:00")]
    );
    expect(ids(m.byWorkout["Badminton (Cross-Training)"])).toEqual([1]);
    expect(ids(m.unplanned)).toEqual([2]);
  });

  it("matches strength training", () => {
    const m = matchDay([workout("gym", "strength")], [activity(1, "WeightTraining", "18:00")]);
    expect(ids(m.byWorkout.gym)).toEqual([1]);
  });
});
