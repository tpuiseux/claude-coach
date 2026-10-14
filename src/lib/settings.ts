import type { TrainingPlan, AthleteZones, UnitPreferences } from "../schema/training-plan.js";

/**
 * Ported from viewer/stores/settings.ts, minus loadSettings/saveSettings -
 * those read/wrote localStorage, which no longer exists as the source of
 * truth now that plans live in the DB. deriveSettingsFromPlan below covers
 * what loadSettings did except the final "override with the user's saved
 * settings" step; per-user zone/theme overrides are a later addition (the
 * SaaS migration plan defers full Settings UI porting).
 */

export interface HrZone {
  zone: number;
  name: string;
  low: number;
  high: number;
}

export interface PowerZone {
  zone: number;
  name: string;
  low: number;
  high: number;
}

export interface PaceZone {
  zone: string | number;
  name: string;
  pace: string;
  offset?: number;
  // Run pace zones only: the plan's precise range (low = slower bound,
  // e.g. "5:55/km"), which the Garmin export uses as the workout target.
  // Settings only edits the single `pace` value, so boundsPace records the
  // pace these bounds were defined around - buildZonesFromSettings rescales
  // them by pace/boundsPace, keeping them in step with any edit or
  // recalculation instead of either going stale or being dropped.
  low?: string;
  high?: string;
  boundsPace?: string;
}

export type Theme = "dark" | "light";

export interface Settings {
  theme: Theme;
  units: {
    swim: "meters" | "yards";
    bike: "kilometers" | "miles";
    run: "kilometers" | "miles";
  };
  firstDayOfWeek: "monday" | "sunday";
  run: {
    lthr: number;
    hrZones: HrZone[];
    thresholdPace: string;
    paceZones: PaceZone[];
  };
  bike: {
    lthr: number;
    hrZones: HrZone[];
    ftp: number;
    powerZones: PowerZone[];
  };
  swim: {
    css: string;
    cssSeconds: number;
    paceZones: PaceZone[];
  };
}

const defaultSettings: Settings = {
  theme: "dark",
  units: { swim: "meters", bike: "kilometers", run: "kilometers" },
  firstDayOfWeek: "monday",
  run: {
    lthr: 165,
    hrZones: [
      { zone: 1, name: "Recovery", low: 0, high: 134 },
      { zone: 2, name: "Aerobic", low: 134, high: 147 },
      { zone: 3, name: "Tempo", low: 147, high: 156 },
      { zone: 4, name: "Threshold", low: 156, high: 165 },
      { zone: 5, name: "VO2max", low: 165, high: 180 },
    ],
    thresholdPace: "4:30",
    paceZones: [
      { zone: "E", name: "Easy", pace: "5:20" },
      { zone: "M", name: "Marathon", pace: "4:50" },
      { zone: "T", name: "Threshold", pace: "4:30" },
      { zone: "I", name: "Interval", pace: "4:00" },
      { zone: "R", name: "Repetition", pace: "3:40" },
    ],
  },
  bike: {
    lthr: 160,
    hrZones: [
      { zone: 1, name: "Recovery", low: 0, high: 130 },
      { zone: 2, name: "Aerobic", low: 130, high: 142 },
      { zone: 3, name: "Tempo", low: 142, high: 151 },
      { zone: 4, name: "Threshold", low: 151, high: 160 },
      { zone: 5, name: "VO2max", low: 160, high: 175 },
    ],
    ftp: 200,
    powerZones: [
      { zone: 1, name: "Active Recovery", low: 0, high: 110 },
      { zone: 2, name: "Endurance", low: 110, high: 150 },
      { zone: 3, name: "Tempo", low: 150, high: 180 },
      { zone: 4, name: "Threshold", low: 180, high: 210 },
      { zone: 5, name: "VO2max", low: 210, high: 240 },
    ],
  },
  swim: {
    css: "1:50",
    cssSeconds: 110,
    paceZones: [
      { zone: 1, name: "Recovery", offset: 20, pace: "2:10" },
      { zone: 2, name: "Aerobic", offset: 10, pace: "2:00" },
      { zone: 3, name: "Tempo", offset: 5, pace: "1:55" },
      { zone: 4, name: "Threshold", offset: 0, pace: "1:50" },
      { zone: 5, name: "VO2max", offset: -5, pace: "1:45" },
    ],
  },
};

/** Builds Settings from a plan's own preferences/zones, layered over sane defaults. */
export function deriveSettingsFromPlan(plan: TrainingPlan): Settings {
  const settings: Settings = JSON.parse(JSON.stringify(defaultSettings));

  if (plan.preferences) {
    settings.units.swim = plan.preferences.swim || settings.units.swim;
    settings.units.bike = plan.preferences.bike || settings.units.bike;
    settings.units.run = plan.preferences.run || settings.units.run;
    settings.firstDayOfWeek = plan.preferences.firstDayOfWeek || settings.firstDayOfWeek;
  }

  const zones = plan.zones;
  if (zones?.run?.hr) {
    settings.run.lthr = zones.run.hr.lthr;
    if (zones.run.hr.zones) {
      settings.run.hrZones = zones.run.hr.zones.map((z) => ({
        zone: Number(z.zone),
        name: z.name,
        low: z.hrLow,
        high: z.hrHigh ?? 0,
      }));
    }
  }
  if (zones?.run?.pace) {
    settings.run.thresholdPace = zones.run.pace.thresholdPace || settings.run.thresholdPace;
    if (zones.run.pace.zones) {
      settings.run.paceZones = zones.run.pace.zones.map((z) => ({
        zone: z.zone,
        name: z.name,
        pace: z.pace,
        ...(z.low && z.high ? { low: z.low, high: z.high, boundsPace: z.pace } : {}),
      }));
    }
  }
  if (zones?.bike?.hr) {
    settings.bike.lthr = zones.bike.hr.lthr;
    if (zones.bike.hr.zones) {
      settings.bike.hrZones = zones.bike.hr.zones.map((z) => ({
        zone: Number(z.zone),
        name: z.name,
        low: z.hrLow,
        high: z.hrHigh ?? 0,
      }));
    }
  }
  if (zones?.bike?.power) {
    settings.bike.ftp = zones.bike.power.ftp;
    if (zones.bike.power.zones) {
      settings.bike.powerZones = zones.bike.power.zones.map((z) => ({
        zone: Number(z.zone),
        name: z.name,
        low: z.wattsLow,
        high: z.wattsHigh,
      }));
    }
  }
  if (zones?.swim) {
    settings.swim.css = zones.swim.css || settings.swim.css;
    settings.swim.cssSeconds = zones.swim.cssSeconds || settings.swim.cssSeconds;
    if (zones.swim.zones) {
      settings.swim.paceZones = zones.swim.zones.map((z) => ({
        zone: z.zone,
        name: z.name,
        offset: z.paceOffset,
        pace: z.pace,
      }));
    }
  }

  return settings;
}

export function paceToSeconds(pace: string): number {
  if (!pace) return 0;
  const parts = pace.split(":");
  return parseInt(parts[0] ?? "0") * 60 + parseInt(parts[1] ?? "0");
}

export function secondsToPace(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function recalculateHrZones(lthr: number): HrZone[] {
  const percentages = [
    { zone: 1, name: "Recovery", lowPct: 0, highPct: 81 },
    { zone: 2, name: "Aerobic", lowPct: 81, highPct: 89 },
    { zone: 3, name: "Tempo", lowPct: 89, highPct: 94 },
    { zone: 4, name: "Threshold", lowPct: 94, highPct: 100 },
    { zone: 5, name: "VO2max", lowPct: 100, highPct: 106 },
  ];
  return percentages.map((p) => ({
    zone: p.zone,
    name: p.name,
    low: Math.round((lthr * p.lowPct) / 100),
    high: Math.round((lthr * p.highPct) / 100),
  }));
}

export function recalculatePowerZones(ftp: number): PowerZone[] {
  const percentages = [
    { zone: 1, name: "Active Recovery", lowPct: 0, highPct: 55 },
    { zone: 2, name: "Endurance", lowPct: 55, highPct: 75 },
    { zone: 3, name: "Tempo", lowPct: 75, highPct: 90 },
    { zone: 4, name: "Threshold", lowPct: 90, highPct: 105 },
    { zone: 5, name: "VO2max", lowPct: 105, highPct: 120 },
  ];
  return percentages.map((p) => ({
    zone: p.zone,
    name: p.name,
    low: Math.round((ftp * p.lowPct) / 100),
    high: Math.round((ftp * p.highPct) / 100),
  }));
}

/**
 * Covers the zones that scale as a fixed % of threshold pace: E/S/T/I/R.
 * Deliberately does NOT include Race Pace (RP) - per reference/zones.md,
 * that one tracks the goal race's distance (~Zone 5b for 5K down to ~Zone 3
 * for marathon), not a fixed offset from threshold, so there's no single
 * factor that's correct for every plan. Callers should merge this into the
 * existing zone list rather than replacing it outright, so RP (and any
 * other non-standard zone a plan might have) survives a recalculation.
 */
export function recalculateRunPaceZones(thresholdPace: string): PaceZone[] {
  const tSeconds = paceToSeconds(thresholdPace);
  const zones = [
    { zone: "E", name: "Easy (E)", factor: 1.18 },
    { zone: "S", name: "Steady (S)", factor: 1.07 },
    { zone: "T", name: "Threshold (T)", factor: 1.0 },
    { zone: "I", name: "VO2max (I)", factor: 0.89 },
    { zone: "R", name: "Repetition (R)", factor: 0.82 },
  ];
  return zones.map((z) => ({
    zone: z.zone,
    name: z.name,
    pace: secondsToPace(Math.round(tSeconds * z.factor)),
  }));
}

/**
 * Applies a recalculateRunPaceZones result onto the current zone list:
 * recalculated zones replace their namesakes but keep those zones' plan
 * bounds (low/high/boundsPace, rescaled later by buildZonesFromSettings),
 * and zones the recalculation doesn't cover (Race Pace, or anything else a
 * plan defines) are kept as-is rather than dropped.
 */
export function mergeRecalculatedRunPaceZones(
  current: PaceZone[],
  recalculated: PaceZone[]
): PaceZone[] {
  const currentByCode = new Map(current.map((z) => [String(z.zone), z]));
  const recalculatedCodes = new Set(recalculated.map((z) => String(z.zone)));

  const refreshed = recalculated.map((z) => {
    const previous = currentByCode.get(String(z.zone));
    if (!previous?.low || !previous.high || !previous.boundsPace) return z;
    return { ...z, low: previous.low, high: previous.high, boundsPace: previous.boundsPace };
  });
  const preserved = current.filter((z) => !recalculatedCodes.has(String(z.zone)));
  return [...refreshed, ...preserved];
}

export function recalculateSwimPaceZones(css: string): PaceZone[] {
  const cssSeconds = paceToSeconds(css);
  const offsets = [
    { zone: 1, name: "Recovery", offset: 20 },
    { zone: 2, name: "Aerobic", offset: 10 },
    { zone: 3, name: "Tempo", offset: 5 },
    { zone: 4, name: "Threshold", offset: 0 },
    { zone: 5, name: "VO2max", offset: -5 },
  ];
  return offsets.map((z) => ({
    zone: z.zone,
    name: z.name,
    offset: z.offset,
    pace: secondsToPace(cssSeconds + z.offset),
  }));
}

/** Scales a pace string like "5:55/km" by `ratio`, keeping its unit suffix. */
function scalePace(pace: string, ratio: number): string {
  const suffix = pace.match(/\/.*$/)?.[0] ?? "";
  return secondsToPace(Math.round(paceToSeconds(pace) * ratio)) + suffix;
}

/** The zone's plan bounds, rescaled to its current pace - or none, if the
 * zone never had bounds (the Garmin export then falls back to a band
 * around `pace`). */
function runPaceBounds(zone: PaceZone): { low: string; high: string } | Record<string, never> {
  if (!zone.low || !zone.high || !zone.boundsPace) return {};
  const from = paceToSeconds(zone.boundsPace);
  const to = paceToSeconds(zone.pace);
  if (!(from > 0) || !(to > 0)) return {};
  if (from === to) return { low: zone.low, high: zone.high };
  return { low: scalePace(zone.low, to / from), high: scalePace(zone.high, to / from) };
}

function percentOf(value: number, base: number): number {
  return base > 0 ? Math.round((value / base) * 100) : 0;
}

/**
 * Inverse of deriveSettingsFromPlan's zone extraction - rebuilds the plan's
 * AthleteZones shape from an edited Settings object, so Settings edits can
 * be persisted straight back onto the plan (see PATCH /plans/[id]).
 * percentLow/percentHigh are recomputed from low/high vs the threshold,
 * since Settings' zone shape doesn't carry them - exact after
 * "Recalculate", a reasonable derived value after a manual edit.
 */
export function buildZonesFromSettings(settings: Settings): AthleteZones {
  return {
    run: {
      hr: {
        lthr: settings.run.lthr,
        zones: settings.run.hrZones.map((z) => ({
          zone: z.zone,
          name: z.name,
          percentLow: percentOf(z.low, settings.run.lthr),
          percentHigh: percentOf(z.high, settings.run.lthr),
          hrLow: z.low,
          hrHigh: z.high,
        })),
      },
      pace: {
        thresholdPace: settings.run.thresholdPace,
        thresholdPaceSeconds: paceToSeconds(settings.run.thresholdPace),
        zones: settings.run.paceZones.map((z) => ({
          zone: String(z.zone),
          name: z.name,
          pace: z.pace,
          paceSeconds: paceToSeconds(z.pace),
          ...runPaceBounds(z),
        })),
      },
    },
    bike: {
      hr: {
        lthr: settings.bike.lthr,
        zones: settings.bike.hrZones.map((z) => ({
          zone: z.zone,
          name: z.name,
          percentLow: percentOf(z.low, settings.bike.lthr),
          percentHigh: percentOf(z.high, settings.bike.lthr),
          hrLow: z.low,
          hrHigh: z.high,
        })),
      },
      power: {
        ftp: settings.bike.ftp,
        zones: settings.bike.powerZones.map((z) => ({
          zone: z.zone,
          name: z.name,
          percentLow: percentOf(z.low, settings.bike.ftp),
          percentHigh: percentOf(z.high, settings.bike.ftp),
          wattsLow: z.low,
          wattsHigh: z.high,
        })),
      },
    },
    swim: {
      css: settings.swim.css,
      cssSeconds: settings.swim.cssSeconds,
      zones: settings.swim.paceZones.map((z) => ({
        zone: Number(z.zone),
        name: z.name,
        paceOffset: z.offset ?? 0,
        pace: z.pace,
      })),
    },
  };
}

export function buildPreferencesFromSettings(settings: Settings): UnitPreferences {
  return {
    swim: settings.units.swim,
    bike: settings.units.bike,
    run: settings.units.run,
    firstDayOfWeek: settings.firstDayOfWeek,
  };
}
