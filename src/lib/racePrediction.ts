/**
 * Race-time prediction from recorded training. Several independent
 * estimates, each from a different signal in the athlete's runs, averaged
 * into one predicted finish time - recomputed week by week so the plan view
 * can show how it moved as training went on. Shared by the server
 * (lib/server/racePrediction.ts feeds it the runs) and the sidebar card
 * (lib/components/RacePrediction.svelte).
 *
 * Every estimate here is a published, well-known model, kept simple on
 * purpose: the athlete should be able to see why the number moved.
 */

import type { TrainingPlan } from "../schema/training-plan.js";
import type { ActivitySeries } from "./activityAnalysis.js";

export interface RaceTarget {
  distanceMeters: number;
  /** The plan's goal finish time, in seconds. */
  goalSeconds: number | null;
  /** The heart rate the plan says to race at (middle of its range). */
  raceHr: number | null;
}

/** A stretch of a run covered as fast as the athlete covered it. */
export interface Effort {
  distanceMeters: number;
  seconds: number;
}

/** One full kilometre of a run: its average speed (m/s) and heart rate. */
export interface Split {
  speed: number;
  hr: number;
}

/** What a run brings to the prediction - computed once per run. */
export interface RunSummary {
  id: number;
  /** Local date, YYYY-MM-DD. */
  date: string;
  distanceMeters: number;
  movingSeconds: number;
  efforts: Effort[];
  splits: Split[];
}

export interface Vo2maxReading {
  date: string;
  value: number;
}

export type Estimate =
  | {
      kind: "effort";
      seconds: number;
      /** The effort it extrapolates from. */
      effort: Effort & { date: string };
    }
  | {
      kind: "heartRate";
      seconds: number;
      hr: number;
      /** m/s the athlete holds at that heart rate. */
      speed: number;
      /** How many kilometres the trend is drawn from. */
      splits: number;
    }
  | { kind: "volume"; seconds: number; kmPerWeek: number; paceSecondsPerKm: number }
  | { kind: "vo2max"; seconds: number; vo2max: number; date: string };

export interface Prediction {
  /** The day it's computed as of (YYYY-MM-DD), using training up to that day. */
  date: string;
  /** Average of the estimates; null when none could be made. */
  seconds: number | null;
  estimates: Estimate[];
}

export interface RacePrediction {
  target: RaceTarget;
  current: Prediction;
  /** One point a week up to `current`, oldest first. */
  history: { date: string; seconds: number }[];
}

const MARATHON = 42195;
const HALF_MARATHON = 21097.5;

/** Riegel's endurance exponent: time grows a little faster than distance. */
const RIEGEL_EXPONENT = 1.06;

/** Stretches looked for inside each run, from its samples. */
const EFFORT_DISTANCES = [3000, 5000, 10000, 15000, HALF_MARATHON, 30000];

/** How far back efforts and volume count. */
const WINDOW_DAYS = 56;
/** How far back heart rate vs pace counts - shorter, so it follows fitness. */
const HR_WINDOW_DAYS = 28;
/** A Garmin VO2max older than this is stale. */
const VO2MAX_MAX_AGE_DAYS = 14;
/** Below this a "run" kilometre is walking or stopped. */
const MIN_RUN_SPEED = 2.0;
/** Above this a stretch is a GPS glitch, not a runner. */
const MAX_RUN_SPEED = 6.5;

// ---------------------------------------------------------------------------
// The race, from the plan
// ---------------------------------------------------------------------------

/** "3:12:00" -> 11520. */
function parseClock(text: string): number | null {
  const m = text.match(/(\d+):(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** "4:33/km" -> 273 (per km), "7:20/mi" -> per km too. */
function parsePacePerKm(text: string): number | null {
  const m = text.match(/(\d+):(\d{2})\s*\/\s*(km|mi)/);
  if (!m) return null;
  const seconds = Number(m[1]) * 60 + Number(m[2]);
  return m[3] === "mi" ? seconds / 1.60934 : seconds;
}

function distanceFromName(name: string): number | null {
  if (/half|semi/i.test(name)) return HALF_MARATHON;
  if (/marathon/i.test(name)) return MARATHON;
  if (/\b10\s?k/i.test(name)) return 10000;
  if (/\b5\s?k/i.test(name)) return 5000;
  return null;
}

/** Share of threshold heart rate a race of this length is run at. */
function raceHrFraction(distanceMeters: number): number {
  if (distanceMeters >= MARATHON - 1000) return 0.87;
  if (distanceMeters >= HALF_MARATHON - 500) return 0.93;
  if (distanceMeters >= 10000) return 0.97;
  return 1.0;
}

/**
 * The race to predict: its distance, goal time and race heart rate, from
 * the plan. Null for anything that isn't a running race - a triathlon's
 * finish depends on far more than the runs.
 */
export function raceTarget(plan: TrainingPlan): RaceTarget | null {
  const event = plan.raceStrategy?.event;
  const distances = event?.distances;
  if (distances?.swim || distances?.bike) return null;

  let distanceMeters: number | null = null;
  if (distances?.run) {
    // Plans give it in km (42.195); accept metres too.
    distanceMeters = distances.run < 300 ? distances.run * 1000 : distances.run;
  } else {
    distanceMeters =
      distanceFromName(event?.type ?? "") ??
      distanceFromName(event?.name ?? "") ??
      distanceFromName(plan.meta?.event ?? "");
  }
  if (!distanceMeters) return null;

  const pacing = plan.raceStrategy?.pacing?.run;
  // goalTime isn't in the schema but the coach skill writes it next to the paces.
  const goalTime = (plan.zones?.run?.pace as { goalTime?: unknown } | undefined)?.goalTime;
  let goalSeconds = typeof goalTime === "string" ? parseClock(goalTime) : null;
  if (goalSeconds === null && pacing?.targetPace) {
    const pace = parsePacePerKm(pacing.targetPace);
    if (pace) goalSeconds = Math.round((pace * distanceMeters) / 1000);
  }

  let raceHr: number | null = null;
  const hrRange = pacing?.targetHR?.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})/);
  if (hrRange) {
    raceHr = (Number(hrRange[1]) + Number(hrRange[2])) / 2;
  } else if (pacing?.targetHR?.match(/^\s*\d{2,3}\b/)) {
    raceHr = parseInt(pacing.targetHR, 10);
  } else if (plan.zones?.run?.hr?.lthr) {
    raceHr = Math.round(plan.zones.run.hr.lthr * raceHrFraction(distanceMeters));
  }

  return { distanceMeters, goalSeconds, raceHr };
}

// ---------------------------------------------------------------------------
// What each run brings
// ---------------------------------------------------------------------------

interface Point {
  d: number;
  t: number;
  hr: number | null;
}

function points(series: ActivitySeries): Point[] {
  const { distance, time, heartrate } = series;
  if (!distance || !time) return [];
  const out: Point[] = [];
  for (let i = 0; i < distance.length; i++) {
    const d = distance[i];
    const t = time[i];
    if (d === null || t === null || d === undefined || t === undefined) continue;
    // Samples go forward; a step back is a device glitch.
    if (out.length > 0 && (d < out[out.length - 1].d || t <= out[out.length - 1].t)) continue;
    out.push({ d, t, hr: heartrate?.[i] ?? null });
  }
  return out;
}

/**
 * Seconds of the fastest stretch of `target` metres in the run, or null
 * when the run is shorter. Pauses don't count - the time samples skip them.
 */
export function fastestStretch(pts: Point[], target: number): number | null {
  let best = Infinity;
  let i = 0;
  for (let j = 1; j < pts.length; j++) {
    // Tightest start that still covers the target.
    while (i + 1 < j && pts[j].d - pts[i + 1].d >= target) i++;
    const covered = pts[j].d - pts[i].d;
    if (covered < target) continue;
    const seconds = ((pts[j].t - pts[i].t) * target) / covered;
    if (seconds < best) best = seconds;
  }
  return best === Infinity ? null : best;
}

/** Each full kilometre after the first (the warm-up), with its heart rate. */
export function kilometreSplits(pts: Point[]): Split[] {
  const out: Split[] = [];
  let km = 1;
  let start: Point | null = null;
  let hrSum = 0;
  let hrSeconds = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const p = pts[i];
    if (prev.d < km * 1000) continue;
    if (!start) start = prev;
    if (p.hr !== null && p.hr > 0) {
      hrSum += p.hr * (p.t - prev.t);
      hrSeconds += p.t - prev.t;
    }
    if (p.d >= (km + 1) * 1000) {
      const seconds = p.t - start.t;
      const speed = (p.d - start.d) / seconds;
      // Most of the kilometre needs a heart rate, or it says nothing.
      if (hrSeconds >= seconds * 0.8 && speed >= MIN_RUN_SPEED && speed <= MAX_RUN_SPEED) {
        out.push({ speed, hr: hrSum / hrSeconds });
      }
      km = Math.floor(p.d / 1000);
      start = p;
      hrSum = 0;
      hrSeconds = 0;
    }
  }
  return out;
}

/**
 * The run's efforts and splits. With samples, that's its fastest stretch
 * over each standard distance; without (details not fetched yet), the run
 * as a whole is its one effort.
 */
export function summarizeRun(
  run: { id: number; date: string; distanceMeters: number; movingSeconds: number },
  series: ActivitySeries | null
): RunSummary {
  const efforts: Effort[] = [];
  if (run.distanceMeters > 0 && run.movingSeconds > 0) {
    efforts.push({ distanceMeters: run.distanceMeters, seconds: run.movingSeconds });
  }
  const pts = series ? points(series) : [];
  for (const distanceMeters of EFFORT_DISTANCES) {
    const seconds = fastestStretch(pts, distanceMeters);
    if (seconds !== null) efforts.push({ distanceMeters, seconds });
  }
  return { ...run, efforts, splits: kilometreSplits(pts) };
}

// ---------------------------------------------------------------------------
// The models
// ---------------------------------------------------------------------------

/** Riegel: a time over one distance carried over to another. */
export function riegel(seconds: number, fromMeters: number, toMeters: number): number {
  return seconds * Math.pow(toMeters / fromMeters, RIEGEL_EXPONENT);
}

/**
 * Tanda (2011): marathon pace from the last 8 weeks of training alone -
 * weekly volume K (km) and average training pace P (s/km):
 * pace = 17.1 + 140·e^(-0.0053·K) + 0.55·P. It's what makes the prediction
 * honest about a thin base: a fast 10K says little about the last 10 km of
 * a marathon run on 40 km weeks.
 */
export function tandaMarathonSeconds(kmPerWeek: number, paceSecondsPerKm: number): number {
  const pace = 17.1 + 140 * Math.exp(-0.0053 * kmPerWeek) + 0.55 * paceSecondsPerKm;
  return (pace * MARATHON) / 1000;
}

/** Daniels & Gilbert: the VO2max a race result corresponds to. */
export function vdot(distanceMeters: number, seconds: number): number {
  const minutes = seconds / 60;
  const v = distanceMeters / minutes; // m/min
  const cost = -4.6 + 0.182258 * v + 0.000104 * v * v;
  const share =
    0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
  return cost / share;
}

/** The finish time Daniels' tables give for a VO2max - vdot() solved for time. */
export function danielsSeconds(vo2max: number, distanceMeters: number): number {
  // vdot falls as the time grows: bisect between 10 m/s and 1 m/s.
  let fast = distanceMeters / 10;
  let slow = distanceMeters / 1;
  for (let i = 0; i < 60; i++) {
    const mid = (fast + slow) / 2;
    if (vdot(distanceMeters, mid) > vo2max) fast = mid;
    else slow = mid;
  }
  return (fast + slow) / 2;
}

/**
 * Speed held at the race heart rate: a straight line through the recent
 * kilometres' speed vs heart rate, read at that heart rate. With too little
 * spread in heart rate for a line, the kilometres run close to it, averaged.
 */
export function speedAtHr(splits: Split[], hr: number): { speed: number; splits: number } | null {
  const near = splits.filter((s) => s.hr >= hr - 20 && s.hr <= hr + 8);
  if (near.length < 8) return null;

  const hrs = near.map((s) => s.hr);
  const spread = Math.max(...hrs) - Math.min(...hrs);
  if (spread >= 8) {
    const n = near.length;
    const mx = hrs.reduce((a, b) => a + b, 0) / n;
    const my = near.reduce((a, s) => a + s.speed, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const s of near) {
      sxy += (s.hr - mx) * (s.speed - my);
      sxx += (s.hr - mx) ** 2;
    }
    const slope = sxy / sxx;
    // Faster at a higher heart rate, or the line is noise.
    if (slope > 0) {
      const speed = my + slope * (hr - mx);
      if (speed >= MIN_RUN_SPEED && speed <= MAX_RUN_SPEED) return { speed, splits: n };
    }
  }
  const close = near.filter((s) => Math.abs(s.hr - hr) <= 4);
  if (close.length < 5) return null;
  return { speed: close.reduce((a, s) => a + s.speed, 0) / close.length, splits: close.length };
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The prediction as it stood on `date`, from runs up to and including that
 * day. `runs` is every run known, in any order - the oldest also tells
 * volume how much history there is to average over.
 */
export function predictAt(
  date: string,
  target: RaceTarget,
  runs: RunSummary[],
  vo2max: Vo2maxReading[]
): Prediction {
  const D = target.distanceMeters;
  const recent = runs.filter((r) => r.date <= date && r.date > addDays(date, -WINDOW_DAYS));
  const estimates: Estimate[] = [];

  // 1. Best recent effort, carried over to race distance. Only stretches long
  // enough to say something about the race: Riegel from a 3K to a marathon
  // is wishful thinking.
  const minEffort = Math.max(3000, Math.min(10000, D / 4.5));
  let best: Estimate | null = null;
  for (const run of recent) {
    for (const effort of run.efforts) {
      if (effort.distanceMeters < minEffort) continue;
      if (effort.distanceMeters / effort.seconds > MAX_RUN_SPEED) continue;
      const seconds = riegel(effort.seconds, effort.distanceMeters, D);
      if (!best || seconds < best.seconds) {
        best = { kind: "effort", seconds, effort: { ...effort, date: run.date } };
      }
    }
  }
  if (best) estimates.push(best);

  // 2. Speed at race heart rate over the last 4 weeks.
  if (target.raceHr) {
    const splits = runs
      .filter((r) => r.date <= date && r.date > addDays(date, -HR_WINDOW_DAYS))
      .flatMap((r) => r.splits);
    const held = speedAtHr(splits, target.raceHr);
    if (held) {
      estimates.push({
        kind: "heartRate",
        seconds: D / held.speed,
        hr: target.raceHr,
        speed: held.speed,
        splits: held.splits,
      });
    }
  }

  // 3. Training volume (Tanda) - a marathon model, so half marathon and up,
  // and only with three weeks of history at least.
  const firstRun = runs.reduce<string | null>((m, r) => (!m || r.date < m ? r.date : m), null);
  if (D >= HALF_MARATHON - 500 && firstRun) {
    const days = Math.min(WINDOW_DAYS, daysBetween(firstRun, date) + 1);
    const km = recent.reduce((s, r) => s + r.distanceMeters, 0) / 1000;
    const seconds = recent.reduce((s, r) => s + r.movingSeconds, 0);
    if (days >= 21 && km > 0) {
      const kmPerWeek = km / (days / 7);
      const pace = seconds / km;
      estimates.push({
        kind: "volume",
        seconds: riegel(tandaMarathonSeconds(kmPerWeek, pace), MARATHON, D),
        kmPerWeek,
        paceSecondsPerKm: pace,
      });
    }
  }

  // 4. Garmin's VO2max, through Daniels' tables.
  const reading = vo2max
    .filter((v) => v.date <= date && v.date > addDays(date, -VO2MAX_MAX_AGE_DAYS))
    .reduce<Vo2maxReading | null>((m, v) => (!m || v.date > m.date ? v : m), null);
  if (reading) {
    estimates.push({
      kind: "vo2max",
      seconds: danielsSeconds(reading.value, D),
      vo2max: reading.value,
      date: reading.date,
    });
  }

  const seconds =
    estimates.length > 0 ? estimates.reduce((s, e) => s + e.seconds, 0) / estimates.length : null;
  return { date, seconds, estimates };
}

/**
 * The prediction today and one point a week before it, back to 8 weeks
 * before the plan started (or three weeks after the first run, whichever is
 * later). Stops at race day once it's past.
 */
export function racePrediction(
  target: RaceTarget,
  runs: RunSummary[],
  vo2max: Vo2maxReading[],
  today: string,
  planStartDate: string,
  eventDate: string
): RacePrediction {
  const end = eventDate && eventDate < today ? eventDate : today;
  const current = predictAt(end, target, runs, vo2max);

  const firstRun = runs.reduce<string | null>((m, r) => (!m || r.date < m ? r.date : m), null);
  const starts = [addDays(planStartDate || end, -WINDOW_DAYS)];
  if (firstRun) starts.push(addDays(firstRun, 21));
  const start = starts.sort()[starts.length - 1];

  const history: { date: string; seconds: number }[] = [];
  if (current.seconds !== null) history.push({ date: end, seconds: current.seconds });
  for (let date = addDays(end, -7); date >= start; date = addDays(date, -7)) {
    const p = predictAt(date, target, runs, vo2max);
    if (p.seconds !== null) history.unshift({ date, seconds: p.seconds });
  }
  return { target, current, history };
}
