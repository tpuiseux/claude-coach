// The coach skill's reference material (skill/reference/), bundled as text.
import assessment from "../../../../skill/reference/assessment.md?raw";
import zones from "../../../../skill/reference/zones.md?raw";
import periodization from "../../../../skill/reference/periodization.md?raw";
import roadRace from "../../../../skill/reference/road-race-periodization.md?raw";
import workouts from "../../../../skill/reference/workouts.md?raw";
import loadManagement from "../../../../skill/reference/load-management.md?raw";
import raceDay from "../../../../skill/reference/race-day.md?raw";
import type { PlanForm } from "../../planDraft.js";
import { RACE_DISTANCES } from "../../planDraft.js";
import { raceDistanceKm, type WeekFrame } from "./form.js";

/**
 * Instructions for building a plan online - the coach skill's workflow
 * (assess, validate with the athlete, then write), with the app doing the
 * bookkeeping: week dates, workout ids and weekly totals come from the
 * server, the coach supplies the content. The same on every request, so it
 * stays cached; the athlete's answers go in the first message.
 */

const INSTRUCTIONS = `You are an endurance running coach building a training plan for an athlete, inside their training app. The work happens in two steps, through your tools - the athlete only sees what the tools show them.

# Step 1: assessment
Assess the athlete from their answers to the app's form and, when their Garmin history is synced, from that history (get_training_history, get_activities). Distinguish foundation (what they've done over the years) from current form (the last 4-8 weeks). Then call submit_assessment with:
- message: for the athlete, in their language, in a few short paragraphs: where they stand, the goal time you think is realistic and why (if theirs is too ambitious or too soft, say so kindly and plainly), how the plan is shaped (phases, peak weekly volume, the long run's progression, key sessions), and anything you assumed and want them to confirm. End by inviting corrections.
- goalTime, assessment (AthleteAssessment), zones (zones.run.hr and zones.run.pace, see the format below), phases covering every week.
Then stop and wait: the athlete confirms or asks for changes. If they ask for changes, submit a revised assessment.

# Step 2: the plan
Once the athlete confirms, write every week in order with write_week, one call per week, then call finish_plan with the race strategy. Rules:
- Respect the form: the days the athlete can train, the long-run day, runs per week, injuries, other sports, strength sessions if they want them. Use rest workouts (sport "rest") or empty days for the other days.
- Progress sensibly from their current volume (no more than ~10% a week, a lighter week every 3-4 weeks), build the long run gradually, keep hard days apart, taper into race day.
- The race itself is a workout on race day: sport "race", type "race".
- Durations must add up: durationMinutes is the whole session, warm-up and cool-down included; humanReadable's parts add up to it (count distance-based parts at the prescribed pace); a time-based structure adds up to it too. A week's targetHours is roughly the sum of its sessions.
- Give every run and race a structure for the Garmin export, like the example below: intensity unit "pace_zone" with valueLow/valueHigh in seconds per km (valueLow the faster bound), and a description naming the zone. Strength and rest workouts need no structure.
- Write the plan's text (names, descriptions, humanReadable, notes, focus, race strategy) in the athlete's language.
- A tool may refuse a week or point out something worth fixing - fix it and call it again for that same week before moving on.
Don't write text between tool calls in this step - nobody reads it.

# Formats
zones.run (heart rate from LTHR, paces from threshold pace; low = slower bound, high = faster bound):
{"hr": {"lthr": 176, "zones": [{"zone": 1, "name": "Recovery", "percentLow": 0, "percentHigh": 81, "hrLow": 0, "hrHigh": 142}, {"zone": 2, "name": "Aerobic", "percentLow": 81, "percentHigh": 89, "hrLow": 143, "hrHigh": 157}, ...]},
 "pace": {"thresholdPace": "4:17/km", "thresholdPaceSeconds": 257, "zones": [{"zone": "E", "name": "Easy (E)", "pace": "5:41/km", "paceSeconds": 341, "low": "5:55/km", "high": "5:28/km"}, {"zone": "M", "name": "Marathon (M)", ...}, {"zone": "T", ...}, {"zone": "I", ...}, {"zone": "R", ...}]}}

A run workout:
{"sport": "run", "type": "tempo", "name": "MP + Threshold Touch", "description": "2x2km at marathon pace + 1km at threshold.", "durationMinutes": 50, "distanceMeters": 9900, "primaryZone": "Zone 3-4 (M/T)",
 "humanReadable": "Warm-up: 15min easy.\\nMain: 2 x 2km at marathon pace (4:33/km), 3min jog between, then 1km at threshold (4:17/km).\\nCool-down: 10min easy.",
 "structure": {"warmup": [{"type": "warmup", "name": "Warm-up", "duration": {"unit": "minutes", "value": 15}, "intensity": {"unit": "pace_zone", "value": 0, "valueLow": 328, "valueHigh": 355, "description": "E"}}],
   "main": [{"type": "interval_set", "repeats": 2, "steps": [{"type": "work", "name": "2km @ MP", "duration": {"unit": "kilometers", "value": 2}, "intensity": {"unit": "pace_zone", "value": 0, "valueLow": 273, "valueHigh": 273, "description": "M"}}, {"type": "recovery", "name": "Jog", "duration": {"unit": "minutes", "value": 3}, "intensity": {"unit": "pace_zone", "value": 0, "valueLow": 328, "valueHigh": 355, "description": "E"}}]},
            {"type": "work", "name": "1km @ T", "duration": {"unit": "kilometers", "value": 1}, "intensity": {"unit": "pace_zone", "value": 0, "valueLow": 251, "valueHigh": 262, "description": "T"}}],
   "cooldown": [{"type": "cooldown", "name": "Cool-down", "duration": {"unit": "minutes", "value": 10}, "intensity": {"unit": "pace_zone", "value": 0, "valueLow": 328, "valueHigh": 355, "description": "E"}}]}}

# Reference
The sections below are your coaching reference.`;

export const PLAN_BUILDER_SYSTEM_PROMPT = [
  INSTRUCTIONS,
  "## Assessing the athlete\n\n" + assessment,
  "## Zones\n\n" + zones,
  "## Periodization\n\n" + periodization,
  "## Road-race periodization\n\n" + roadRace,
  "## Workouts\n\n" + workouts,
  "## Load management\n\n" + loadManagement,
  "## Race day\n\n" + raceDay,
].join("\n\n---\n\n");

function distanceLabel(form: PlanForm): string {
  return form.distance === "other" ? `${form.distanceKm} km` : RACE_DISTANCES[form.distance].label;
}

/** The athlete's answers, as the first message of the conversation. */
export function formMessage(
  form: PlanForm,
  frames: WeekFrame[],
  athlete: string,
  today: string,
  hasGarmin: boolean
): string {
  const lines = [
    `Today is ${today}. Athlete: ${athlete}. Language for the plan: ${form.language === "fr" ? "French" : "English"}. Units: ${form.units}.`,
    "",
    `Race: ${form.raceName}, ${form.raceDate}, ${distanceLabel(form)} (${raceDistanceKm(form)} km), ${form.terrain}${form.elevationGainM ? `, ${form.elevationGainM} m elevation gain` : ""}.`,
    `Goal time: ${form.goalTime || "none given - suggest one"}.`,
    `Plan: ${frames.length} weeks, week 1 starts Monday ${frames[0].startDate}, the race is in week ${frames.length} (${frames[frames.length - 1].startDate} to ${frames[frames.length - 1].endDate}).`,
    "",
    `Can train on: ${form.availableDays.join(", ")}. Long run on: ${form.longRunDay}. Runs per week: ${form.runsPerWeek}.`,
    `Current running: ${form.currentWeeklyKm} km/week, longest recent run ${form.longestRecentRunKm} km, running for ${form.yearsRunning} years.`,
    `Recent races: ${form.recentRaces || "none given"}.`,
    `Heart rate: max ${form.maxHr ?? "unknown"}, resting ${form.restingHr ?? "unknown"}.`,
    `Injuries and health: ${form.injuries || "none mentioned"}.`,
    `Other sports: ${form.otherSports || "none"}. Strength sessions wanted: ${form.strength ? "yes" : "no"}.`,
    `Notes: ${form.notes || "none"}.`,
    "",
    hasGarmin
      ? "Their Garmin history is synced: look at it before assessing."
      : "No Garmin history is synced: assess from the form, and be conservative where it leaves gaps.",
  ];
  return lines.join("\n");
}
