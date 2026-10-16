/**
 * A recorded activity in detail: its samples over the session (pace, heart
 * rate, altitude...), its laps, and the numbers derived from them. Shared by
 * the server (lib/server/activityDetails.ts builds it) and the activity
 * analysis panel (lib/components/ActivityAnalysis.svelte charts it).
 */

import type { Sport } from "../schema/training-plan.js";
import type { HrZone, Settings } from "./settings.js";

export interface ActivityStats {
  sportType: string | null;
  distanceMeters: number | null;
  movingSeconds: number | null;
  elapsedSeconds: number | null;
  averageSpeed: number | null; // m/s
  maxSpeed: number | null; // m/s
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  elevationGain: number | null; // m
  averageCadence: number | null; // steps/min (run) or rpm (bike)
  averagePower: number | null; // W
  normalizedPower: number | null; // W
  calories: number | null;
  /** Garmin's training effect, 0-5. */
  aerobicEffect: number | null;
  anaerobicEffect: number | null;
  /** Garmin's activity training load (EPOC-based). */
  trainingLoad: number | null;
  /** Garmin's label for the main benefit, e.g. "AEROBIC_BASE". */
  trainingEffectLabel: string | null;
}

/** Samples, one entry per point in every array (null where nothing was recorded). */
export interface ActivitySeries {
  time?: (number | null)[]; // s since start, pauses excluded
  distance?: (number | null)[]; // m
  speed?: (number | null)[]; // m/s
  heartrate?: (number | null)[]; // bpm
  altitude?: (number | null)[]; // m
  cadence?: (number | null)[];
  power?: (number | null)[]; // W
}

export interface ActivityLap {
  distance?: number; // m
  duration?: number; // s
  movingDuration?: number; // s
  averageSpeed?: number; // m/s
  averageHR?: number;
  maxHR?: number;
  averageCadence?: number;
  averagePower?: number;
  elevationGain?: number;
  /** ACTIVE, REST, WARMUP, COOLDOWN, RECOVERY, INTERVAL... */
  intensityType?: string;
}

export interface ActivityAnalysis {
  stats: ActivityStats;
  series: ActivitySeries;
  laps: ActivityLap[];
  /** Why samples and laps are missing (Garmin unreachable, not connected...). */
  detailsError?: string;
}

const KM_PER_MILE = 1.60934;
const METERS_PER_YARD = 0.9144;

/** Below this a runner is walking or stopped - their pace would blow up the chart. */
const MIN_PACE_SPEED: Partial<Record<Sport, number>> = { run: 1.0, swim: 0.2 };

export type SpeedDisplay = "pace-km" | "pace-mi" | "pace-100m" | "pace-100yd" | "kmh" | "mph";

/** How speed reads for a sport: pace for running and swimming, speed for cycling. */
export function speedDisplay(sport: Sport | null, settings: Settings): SpeedDisplay {
  if (sport === "bike") return settings.units.bike === "miles" ? "mph" : "kmh";
  if (sport === "swim") return settings.units.swim === "yards" ? "pace-100yd" : "pace-100m";
  return settings.units.run === "miles" ? "pace-mi" : "pace-km";
}

export function isPaceDisplay(display: SpeedDisplay): boolean {
  return display.startsWith("pace");
}

const PACE_METERS: Record<string, number> = {
  "pace-km": 1000,
  "pace-mi": 1000 * KM_PER_MILE,
  "pace-100m": 100,
  "pace-100yd": 100 * METERS_PER_YARD,
};

/** m/s -> the value plotted: seconds per unit for paces, km/h or mph for speeds. */
export function speedValue(speed: number, display: SpeedDisplay): number {
  if (display === "kmh") return speed * 3.6;
  if (display === "mph") return (speed * 3.6) / KM_PER_MILE;
  return PACE_METERS[display] / speed;
}

export function speedUnit(display: SpeedDisplay): string {
  return {
    "pace-km": "/km",
    "pace-mi": "/mi",
    "pace-100m": "/100m",
    "pace-100yd": "/100yd",
    kmh: "km/h",
    mph: "mph",
  }[display];
}

/** "4:52" for 292 seconds. */
export function formatPaceSeconds(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** A plotted speed value as text, without its unit. */
export function formatSpeedValue(value: number, display: SpeedDisplay): string {
  return isPaceDisplay(display) ? formatPaceSeconds(value) : value.toFixed(1);
}

/** m/s as text with its unit, e.g. "4:52/km" or "31.2 km/h". */
export function formatSpeed(speed: number | null | undefined, display: SpeedDisplay): string {
  if (!speed || speed <= 0) return "–";
  const value = speedValue(speed, display);
  return isPaceDisplay(display)
    ? `${formatPaceSeconds(value)}${speedUnit(display)}`
    : `${value.toFixed(1)} ${speedUnit(display)}`;
}

/** "1:05:12" or "42:07" for a duration in seconds. */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Centred moving average over a time window, skipping nulls. GPS speed
 * jumps around second to second; a ~30 s window shows the pace the athlete
 * actually held without hiding a 200 m repeat. Points with no value of
 * their own stay null, so gaps (stops, dropouts) remain gaps.
 */
export function smoothByTime(
  values: (number | null)[],
  times: (number | null)[],
  windowSeconds: number
): (number | null)[] {
  const half = windowSeconds / 2;
  const out: (number | null)[] = new Array(values.length).fill(null);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < values.length; i++) {
    const t = times[i];
    if (t === null || values[i] === null) continue;
    // Grow the window's right edge up to t + half...
    while (hi < values.length && (times[hi] ?? -Infinity) <= t + half) {
      const v = values[hi];
      if (v !== null && times[hi] !== null) {
        sum += v;
        count++;
      }
      hi++;
    }
    // ...and shrink its left edge past t - half.
    while (lo < hi && (times[lo] ?? Infinity) < t - half) {
      const v = values[lo];
      if (v !== null && times[lo] !== null) {
        sum -= v;
        count--;
      }
      lo++;
    }
    out[i] = count > 0 ? sum / count : null;
  }
  return out;
}

/** Speed in m/s with stops blanked out, so pace doesn't spike to infinity. */
export function movingSpeed(speeds: (number | null)[], sport: Sport | null): (number | null)[] {
  const floor = (sport && MIN_PACE_SPEED[sport]) ?? 0.5;
  return speeds.map((v) => (v !== null && v >= floor ? v : null));
}

/** Seconds each sample stands for: the gap to the next one, capped so a
 * device that stopped recording doesn't credit the gap to one value. */
function sampleDurations(times: (number | null)[], cap = 30): number[] {
  return times.map((t, i) => {
    const next = times[i + 1];
    if (t === null || next === null || next === undefined) return 0;
    return Math.max(0, Math.min(next - t, cap));
  });
}

/** Index of the zone a heart rate falls in: below the first counts as the
 * first, above the last as the last. */
export function zoneIndex(hr: number, zones: HrZone[]): number {
  for (let i = 0; i < zones.length; i++) {
    if (hr < zones[i].high) return i;
  }
  return zones.length - 1;
}

/** Seconds spent in each heart-rate zone, in zone order. */
export function timeInZones(
  times: (number | null)[],
  heartrates: (number | null)[],
  zones: HrZone[]
): number[] {
  const out = zones.map(() => 0);
  if (zones.length === 0) return out;
  const durations = sampleDurations(times);
  heartrates.forEach((hr, i) => {
    if (hr !== null && hr > 0) out[zoneIndex(hr, zones)] += durations[i];
  });
  return out;
}

/**
 * Aerobic decoupling (Pa:HR): how much the speed bought per heartbeat fell
 * from the first half of the session to the second, in %. Under ~5% on a
 * steady endurance session means the aerobic base held up; above, the heart
 * had to work harder for the same pace (fatigue, heat, dehydration).
 * Null when the session is too short or lacks either series - and it only
 * means something for a steady effort, not intervals.
 */
export function aerobicDecoupling(
  times: (number | null)[],
  speeds: (number | null)[],
  heartrates: (number | null)[],
  minSeconds = 20 * 60
): number | null {
  const durations = sampleDurations(times);
  const points: { dt: number; speed: number; hr: number }[] = [];
  for (let i = 0; i < times.length; i++) {
    const speed = speeds[i];
    const hr = heartrates[i];
    if (speed !== null && hr !== null && speed > 0 && hr > 0 && durations[i] > 0) {
      points.push({ dt: durations[i], speed, hr });
    }
  }
  const total = points.reduce((s, p) => s + p.dt, 0);
  if (total < minSeconds) return null;

  const halves = [
    { t: 0, speed: 0, hr: 0 },
    { t: 0, speed: 0, hr: 0 },
  ];
  let elapsed = 0;
  for (const p of points) {
    const h = halves[elapsed < total / 2 ? 0 : 1];
    h.t += p.dt;
    h.speed += p.speed * p.dt;
    h.hr += p.hr * p.dt;
    elapsed += p.dt;
  }
  const [first, second] = halves.map((h) => h.speed / h.hr);
  if (!first || !second) return null;
  return ((first - second) / first) * 100;
}

/**
 * Picks evenly spaced samples so a chart never draws more points than it
 * has pixels. Keeps the first and last.
 */
export function downsampleIndices(length: number, maxPoints: number): number[] {
  if (length <= maxPoints) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => Math.round(i * step));
}
