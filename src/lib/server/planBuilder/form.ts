import {
  RACE_DISTANCES,
  WEEKDAYS,
  type PlanForm,
  type RaceDistanceKey,
  type Weekday,
} from "../../planDraft.js";
import { isIsoDate, ValidationError } from "../validation.js";

/** The "Create a plan" form, validated, and the weeks it makes room for. */

export const MIN_WEEKS = 3;
export const MAX_WEEKS = 30;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown, min: number, max: number, name: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

function optionalNum(value: unknown, min: number, max: number, name: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return num(value, min, max, name);
}

export function dayOfWeek(date: string): Weekday {
  // getUTCDay: 0 = Sunday.
  return WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or after a date. */
export function nextMonday(date: string): string {
  const offset = (7 - WEEKDAYS.indexOf(dayOfWeek(date))) % 7;
  return addDays(date, offset);
}

export function parsePlanForm(input: unknown, today: string): PlanForm {
  if (!isPlainObject(input)) throw new ValidationError("The form is empty");

  const raceName = text(input.raceName, 120);
  if (!raceName) throw new ValidationError("Give the race a name");
  if (!isIsoDate(input.raceDate)) throw new ValidationError("Race date is missing");
  const raceDate = input.raceDate;

  const distance = input.distance as RaceDistanceKey;
  if (!(distance in RACE_DISTANCES) && distance !== "other") {
    throw new ValidationError("Pick the race distance");
  }
  const distanceKm = distance === "other" ? num(input.distanceKm, 1, 400, "Distance") : null;

  const goalTime = text(input.goalTime, 20);
  if (goalTime && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(goalTime)) {
    throw new ValidationError("Goal time looks like 3:15:00 or 45:30");
  }

  if (!isIsoDate(input.startDate)) throw new ValidationError("Start date is missing");
  const startDate = input.startDate;
  if (dayOfWeek(startDate) !== "monday") throw new ValidationError("The plan starts on a Monday");
  if (startDate < addDays(today, -6)) throw new ValidationError("The start date is in the past");
  if (raceDate <= startDate) throw new ValidationError("The race is before the plan starts");
  const weeks = totalWeeks(startDate, raceDate);
  if (weeks < MIN_WEEKS || weeks > MAX_WEEKS) {
    throw new ValidationError(
      `A plan runs ${MIN_WEEKS} to ${MAX_WEEKS} weeks (this one: ${weeks})`
    );
  }

  const availableDays = Array.isArray(input.availableDays)
    ? WEEKDAYS.filter((d) => (input.availableDays as unknown[]).includes(d))
    : [];
  if (availableDays.length < 2) throw new ValidationError("Pick at least two days you can train");
  const longRunDay = WEEKDAYS.includes(input.longRunDay as Weekday)
    ? (input.longRunDay as Weekday)
    : availableDays[availableDays.length - 1];

  return {
    raceName,
    raceDate,
    distance,
    distanceKm,
    terrain: input.terrain === "trail" ? "trail" : "road",
    elevationGainM: optionalNum(input.elevationGainM, 0, 20000, "Elevation gain"),
    goalTime,
    startDate,
    availableDays,
    longRunDay,
    runsPerWeek: num(input.runsPerWeek, 2, 7, "Runs per week"),
    currentWeeklyKm: num(input.currentWeeklyKm, 0, 300, "Weekly distance"),
    longestRecentRunKm: num(input.longestRecentRunKm, 0, 150, "Longest recent run"),
    yearsRunning: num(input.yearsRunning, 0, 60, "Years running"),
    recentRaces: text(input.recentRaces),
    maxHr: optionalNum(input.maxHr, 120, 230, "Max heart rate"),
    restingHr: optionalNum(input.restingHr, 30, 100, "Resting heart rate"),
    injuries: text(input.injuries),
    otherSports: text(input.otherSports),
    strength: input.strength === true,
    units: input.units === "miles" ? "miles" : "kilometers",
    language: input.language === "fr" ? "fr" : "en",
    notes: text(input.notes),
  };
}

/** Weeks from the start Monday to the week of the race, inclusive. */
export function totalWeeks(startDate: string, raceDate: string): number {
  const days = Math.round(
    (Date.parse(`${raceDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  );
  return Math.floor(days / 7) + 1;
}

export interface WeekFrame {
  weekNumber: number;
  startDate: string;
  endDate: string;
  dates: string[];
}

export function weekFrames(startDate: string, raceDate: string): WeekFrame[] {
  return Array.from({ length: totalWeeks(startDate, raceDate) }, (_, i) => {
    const start = addDays(startDate, i * 7);
    return {
      weekNumber: i + 1,
      startDate: start,
      endDate: addDays(start, 6),
      dates: Array.from({ length: 7 }, (_, d) => addDays(start, d)),
    };
  });
}

export function raceDistanceKm(form: PlanForm): number {
  return form.distance === "other" ? form.distanceKm! : RACE_DISTANCES[form.distance].km;
}
