/**
 * Training load and recovery, day by day: Garmin's acute and chronic load
 * and their ratio (ACWR), HRV, sleep, resting heart rate and readiness - and
 * the fatigue signals worth acting on. Shared by the server
 * (lib/server/load.ts reads the days) and the plan's Load & recovery panel
 * (lib/components/LoadPanel.svelte).
 */

export interface LoadDay {
  date: string;
  /** Last 7 days' load (Garmin's acute training load). */
  acute: number | null;
  /** Last 4 weeks' load, per week (Garmin's chronic training load). */
  chronic: number | null;
  acwr: number | null;
  hrv: number | null;
  hrvWeekly: number | null;
  hrvStatus: string | null;
  sleepScore: number | null;
  restingHr: number | null;
  readiness: number | null;
}

export interface LoadSeries {
  days: LoadDay[];
  /** Where acute/chronic come from: Garmin's own figures, or worked out here
   * from each activity's training load when Garmin's are missing. */
  loadSource: "garmin" | "activities";
}

/** The daily_wellness columns read here. */
export interface WellnessRow {
  date: string;
  acute_training_load: number | null;
  chronic_training_load: number | null;
  acwr: number | null;
  hrv_last_night_avg: number | null;
  hrv_weekly_avg: number | null;
  hrv_status: string | null;
  sleep_score: number | null;
  resting_hr: number | null;
  training_readiness_score: number | null;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Acute and chronic load from each day's summed activity load, for when
 * Garmin's figures are missing: exponentially weighted averages over 7 and
 * 28 days, scaled to a week (Garmin's acute load is a 7-day sum, so the two
 * read alike).
 */
export function loadFromActivities(
  dailyLoad: Record<string, number>,
  start: string,
  end: string
): Record<string, { acute: number; chronic: number }> {
  const first = Object.keys(dailyLoad).sort()[0];
  if (!first) return {};
  const out: Record<string, { acute: number; chronic: number }> = {};
  let acute = 0;
  let chronic = 0;
  // Warm up from the first activity so day one of the range isn't zero.
  for (let date = first < start ? first : start; date <= end; date = addDays(date, 1)) {
    const load = dailyLoad[date] ?? 0;
    acute += (load - acute) * (2 / (7 + 1));
    chronic += (load - chronic) * (2 / (28 + 1));
    if (date >= start) out[date] = { acute: acute * 7, chronic: chronic * 7 };
  }
  return out;
}

export function buildLoadSeries(
  wellness: WellnessRow[],
  dailyLoad: Record<string, number>,
  start: string,
  end: string
): LoadSeries {
  const byDate = new Map(wellness.map((w) => [w.date, w]));
  const garminLoad = wellness.some((w) => w.acute_training_load !== null);
  const computed = garminLoad ? {} : loadFromActivities(dailyLoad, start, end);

  const days: LoadDay[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const w = byDate.get(date);
    const c = computed[date];
    const acute = garminLoad ? (w?.acute_training_load ?? null) : (c?.acute ?? null);
    const chronic = garminLoad ? (w?.chronic_training_load ?? null) : (c?.chronic ?? null);
    days.push({
      date,
      acute,
      chronic,
      acwr: garminLoad
        ? (w?.acwr ?? null)
        : acute !== null && chronic
          ? Math.round((acute / chronic) * 100) / 100
          : null,
      hrv: w?.hrv_last_night_avg ?? null,
      hrvWeekly: w?.hrv_weekly_avg ?? null,
      hrvStatus: w?.hrv_status ?? null,
      sleepScore: w?.sleep_score ?? null,
      restingHr: w?.resting_hr ?? null,
      readiness: w?.training_readiness_score ?? null,
    });
  }
  return { days, loadSource: garminLoad ? "garmin" : "activities" };
}

export interface FatigueSignal {
  key: "acwr" | "hrv" | "readiness" | "sleep" | "restingHr";
  text: string;
}

const HRV_LOW = ["LOW", "UNBALANCED", "POOR"];

/** How many of the last days, counting back from the end, pass the test. */
function streak(days: LoadDay[], test: (d: LoadDay) => boolean | null): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const r = test(days[i]);
    if (r === null) continue; // no data that day: doesn't break the streak
    if (!r) break;
    n++;
  }
  return n;
}

/**
 * Signs the body is behind the training, as of the last day: load ramping
 * faster than fitness, HRV below its normal range, readiness or sleep low
 * several days running, resting heart rate up on its usual level.
 */
export function fatigueSignals(days: LoadDay[]): FatigueSignal[] {
  const recent = days.slice(-7);
  const out: FatigueSignal[] = [];
  const last = [...recent].reverse().find((d) => d.acwr !== null);
  if (last?.acwr && last.acwr > 1.5) {
    out.push({
      key: "acwr",
      text: `Load ramping fast: ACWR ${last.acwr.toFixed(2)} (keep under ~1.5)`,
    });
  }
  const hrv = streak(recent, (d) =>
    d.hrvStatus ? HRV_LOW.includes(d.hrvStatus.toUpperCase()) : null
  );
  if (hrv >= 3) out.push({ key: "hrv", text: `HRV below your normal range ${hrv} days running` });
  const readiness = streak(recent, (d) => (d.readiness === null ? null : d.readiness < 40));
  if (readiness >= 3)
    out.push({ key: "readiness", text: `Low training readiness ${readiness} days running` });
  const sleep = streak(recent, (d) => (d.sleepScore === null ? null : d.sleepScore < 60));
  if (sleep >= 3) out.push({ key: "sleep", text: `Poor sleep ${sleep} nights running` });

  // Resting HR: the last 3 days against the 4 weeks before them.
  const before = days
    .slice(-31, -3)
    .map((d) => d.restingHr)
    .filter((v): v is number => v !== null);
  const now = days
    .slice(-3)
    .map((d) => d.restingHr)
    .filter((v): v is number => v !== null);
  if (before.length >= 14 && now.length >= 2) {
    const baseline = before.reduce((a, b) => a + b, 0) / before.length;
    const current = now.reduce((a, b) => a + b, 0) / now.length;
    if (current - baseline >= 5) {
      out.push({
        key: "restingHr",
        text: `Resting heart rate up ${Math.round(current - baseline)} bpm on your usual`,
      });
    }
  }
  return out;
}
