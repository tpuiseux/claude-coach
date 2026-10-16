import { describe, expect, it } from "vitest";
import {
  aerobicDecoupling,
  downsampleIndices,
  formatClock,
  formatSpeed,
  movingSpeed,
  smoothByTime,
  timeInZones,
  zoneIndex,
} from "../../src/lib/activityAnalysis.js";

const zones = [
  { zone: 1, name: "Recovery", low: 0, high: 130 },
  { zone: 2, name: "Aerobic", low: 130, high: 145 },
  { zone: 3, name: "Tempo", low: 145, high: 160 },
];

describe("formatting", () => {
  it("formats pace and speed per sport display", () => {
    expect(formatSpeed(1000 / 292, "pace-km")).toBe("4:52/km");
    expect(formatSpeed(10, "kmh")).toBe("36.0 km/h");
    expect(formatSpeed(null, "pace-km")).toBe("–");
  });

  it("formats durations as a clock", () => {
    expect(formatClock(42 * 60 + 7)).toBe("42:07");
    expect(formatClock(3912)).toBe("1:05:12");
  });
});

describe("smoothByTime", () => {
  it("averages within the window and keeps gaps", () => {
    const times = [0, 1, 2, 3, 4];
    const values = [1, 3, null, 5, 7];
    const out = smoothByTime(values, times, 2);
    expect(out[0]).toBe(2); // 1, 3
    expect(out[1]).toBe(2); // 1, 3 (index 2 is null)
    expect(out[2]).toBeNull();
    expect(out[3]).toBe(6); // 5, 7
    expect(out[4]).toBe(6);
  });
});

describe("movingSpeed", () => {
  it("blanks out stops so pace doesn't spike", () => {
    expect(movingSpeed([0, 0.5, 3], "run")).toEqual([null, null, 3]);
  });
});

describe("heart-rate zones", () => {
  it("puts out-of-range values in the edge zones", () => {
    expect(zoneIndex(90, zones)).toBe(0);
    expect(zoneIndex(130, zones)).toBe(1);
    expect(zoneIndex(190, zones)).toBe(2);
  });

  it("weights each sample by the time to the next one", () => {
    const times = [0, 10, 20, 30];
    const hr = [120, 140, 150, 150];
    expect(timeInZones(times, hr, zones)).toEqual([10, 10, 10]);
  });

  it("caps long recording gaps", () => {
    expect(timeInZones([0, 600], [120, 120], zones)).toEqual([30, 0, 0]);
  });
});

describe("aerobicDecoupling", () => {
  const times = Array.from({ length: 1201 }, (_, i) => i * 2); // 40 min
  const speeds = times.map(() => 3);

  it("is ~0 when pace and heart rate hold steady", () => {
    const hr = times.map(() => 140);
    expect(aerobicDecoupling(times, speeds, hr)).toBeCloseTo(0, 5);
  });

  it("is positive when heart rate climbs at the same pace", () => {
    const hr = times.map((t) => (t < 1200 ? 140 : 147));
    expect(aerobicDecoupling(times, speeds, hr)!).toBeCloseTo(4.76, 1);
  });

  it("needs a long enough session", () => {
    expect(aerobicDecoupling([0, 1, 2], [3, 3, 3], [140, 140, 140])).toBeNull();
  });
});

describe("downsampleIndices", () => {
  it("keeps everything when short enough", () => {
    expect(downsampleIndices(3, 10)).toEqual([0, 1, 2]);
  });

  it("keeps the ends and spreads the rest", () => {
    const idx = downsampleIndices(1000, 5);
    expect(idx).toEqual([0, 250, 500, 749, 999]);
  });
});
