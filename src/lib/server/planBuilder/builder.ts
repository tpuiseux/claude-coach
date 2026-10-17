import Anthropic from "@anthropic-ai/sdk";
import { all, get } from "../../../db/client.js";
import type { TrainingPlan } from "../../../schema/training-plan.js";
import type { DraftView } from "../../planDraft.js";
import { autoCompleteFromActivities, resetAutoCompletions } from "../autoComplete.js";
import { errorMessage, getAnthropic } from "../coach/agent.js";
import { recordUsage } from "../coach/store.js";
import { checkRange, listActivities } from "../coach/tools.js";
import { importPlanForUser } from "../plans.js";
import { ValidationError } from "../validation.js";
import { todayLocal } from "../weekReview.js";
import { addDays, raceDistanceKm, weekFrames } from "./form.js";
import { formMessage, PLAN_BUILDER_SYSTEM_PROMPT } from "./prompt.js";
import { appendDraftMessages, getDraft, updateDraft, type Draft } from "./store.js";
import { parseAssessment, parseRaceStrategy, parseWeek } from "./validate.js";

/**
 * Builds a plan with the coach, in the background: the assessment first,
 * which waits for the athlete to confirm or correct it, then the plan,
 * week by week. Every step is stored as it happens, so the page can show
 * progress and a job cut short (a deploy, a crash) carries on from where it
 * stopped when the athlete presses Retry.
 */

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const MODEL = process.env.COACH_PLAN_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.COACH_PLAN_EFFORT || "high") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
const FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(MODEL);
export const PLAN_DAILY_LIMIT = Number(process.env.COACH_PLAN_DAILY_LIMIT || 3);

const TOOL_DEFS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "get_training_history",
    description:
      "The athlete's synced Garmin history, week by week for the last 26 weeks (sessions, km and hours per sport, average heart rate), plus their races and longest runs. Empty when Garmin isn't synced.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_activities",
    description:
      "Recorded activities between two dates: distance, time, pace, heart rate, elevation, training load.",
    input_schema: {
      type: "object",
      properties: { start: { type: "string" }, end: { type: "string" } },
      required: ["start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_assessment",
    description:
      "Show the athlete your assessment and the plan's outline, for them to confirm or correct. Nothing is written until they confirm.",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "For the athlete, in their language (Markdown: short paragraphs, a few bullets)",
        },
        goalTime: { type: "string", description: "The goal you're building the plan for, h:mm:ss" },
        assessment: {
          type: "object",
          description:
            "AthleteAssessment: {foundation: {raceHistory: string[], peakTrainingLoad (h/week), foundationLevel, yearsInSport}, currentForm: {weeklyVolume: {total (h), run}, longestSessions: {run (km)}, consistency (sessions/week)}, strengths: [{sport, evidence}], limiters: [{sport, evidence}], constraints: string[]}",
        },
        zones: {
          type: "object",
          description: "{run: {hr: {...}, pace: {...}}} as in the format section",
        },
        phases: {
          type: "array",
          description:
            "Covering every week in order: [{name, startWeek, endWeek, focus, weeklyHoursRange: {low, high}, keyWorkouts: string[], physiologicalGoals: string[]}]",
          items: { type: "object" },
        },
      },
      required: ["message", "goalTime", "assessment", "zones", "phases"],
    },
  },
  {
    name: "write_week",
    description:
      "Write one week of the plan (after the athlete confirmed the assessment). The app sets workout ids and the week's summary. Returns what it noticed, if anything, and which week comes next.",
    input_schema: {
      type: "object",
      properties: {
        weekNumber: { type: "integer" },
        phase: { type: "string" },
        focus: { type: "string", description: "The week's purpose, one line" },
        targetHours: { type: "number" },
        isRecoveryWeek: { type: "boolean" },
        days: {
          type: "array",
          description: "The 7 days in order: [{date: 'YYYY-MM-DD', workouts: [workout, ...]}]",
          items: { type: "object" },
        },
      },
      required: ["weekNumber", "phase", "focus", "targetHours", "isRecoveryWeek", "days"],
    },
  },
  {
    name: "finish_plan",
    description:
      "Finish the plan once every week is written, with the race strategy: {pacing: {run: {targetPace, targetHR, notes}}, nutrition: {preRace, during: {carbsPerHour, fluidPerHour, products: string[]}, notes}, taper: {startDate, volumeReduction (%), notes}, raceDay: {wakeUpTime?, preRaceMeal?, warmUp?, mentalCues?: string[]}}.",
    input_schema: {
      type: "object",
      properties: { raceStrategy: { type: "object" } },
      required: ["raceStrategy"],
    },
  },
];

// Inputs stream as they are generated; runTool validates them.
const TOOLS = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));

/** Drafts a job is running for, in this process. */
const running = new Set<number>();

export function isRunning(draftId: number): boolean {
  return running.has(draftId);
}

function hasGarminHistory(userId: number): boolean {
  return !!get("SELECT 1 FROM activities WHERE user_id = ? LIMIT 1", [userId]);
}

function trainingHistory(userId: number) {
  const since = addDays(todayLocal(), -182);
  const weeks = all(
    `SELECT strftime('%Y-W%W', COALESCE(start_date_local, start_date)) AS week, sport_type,
            COUNT(*) AS sessions, ROUND(SUM(distance) / 1000.0, 1) AS km,
            ROUND(SUM(moving_time) / 3600.0, 1) AS hours, ROUND(AVG(average_heartrate)) AS avg_hr
     FROM activities WHERE user_id = ? AND COALESCE(start_date_local, start_date) >= ?
     GROUP BY week, sport_type ORDER BY week, sport_type`,
    [userId, since]
  );
  const notable = all(
    `SELECT substr(COALESCE(start_date_local, start_date), 1, 10) AS date, name,
            ROUND(distance / 1000.0, 2) AS km, moving_time AS seconds, ROUND(average_heartrate) AS avg_hr,
            workout_type = 1 AS race
     FROM activities WHERE user_id = ? AND sport_type IN ('Run', 'TrailRun', 'VirtualRun')
       AND (workout_type = 1 OR distance >= 15000)
     ORDER BY start_date DESC LIMIT 30`,
    [userId]
  );
  return { weeks, racesAndLongRuns: notable };
}

function nextWeek(draft: Draft): number | null {
  const total = weekFrames(draft.form.startDate, draft.form.raceDate).length;
  for (let n = 1; n <= total; n++) if (!draft.weeks[n]) return n;
  return null;
}

/** Runs one tool call. Returns its result text; throws ValidationError on bad input. */
function runTool(
  draftId: number,
  userId: number,
  name: string,
  input: Record<string, unknown>
): string {
  const draft = getDraft(userId, draftId)!;
  const frames = weekFrames(draft.form.startDate, draft.form.raceDate);
  switch (name) {
    case "get_training_history":
      return JSON.stringify(trainingHistory(userId));
    case "get_activities": {
      const { start, end } = checkRange(input);
      return JSON.stringify(listActivities(userId, start, end));
    }
    case "submit_assessment": {
      if (draft.status !== "assessing") {
        throw new ValidationError(
          "The athlete already confirmed the assessment - write the weeks."
        );
      }
      updateDraft(draftId, { assessment: parseAssessment(input, frames.length) });
      return "Shown to the athlete. Stop here and wait for their answer.";
    }
    case "write_week": {
      if (draft.status !== "generating" || !draft.assessment) {
        throw new ValidationError(
          "Wait for the athlete to confirm the assessment before writing weeks."
        );
      }
      const frame = frames.find((f) => f.weekNumber === input.weekNumber);
      if (!frame) throw new ValidationError(`weekNumber must be 1 to ${frames.length}`);
      const { week, notes } = parseWeek(input, frame, draft.form, draft.assessment.phases);
      const weeks = { ...draft.weeks, [week.weekNumber]: week };
      updateDraft(draftId, { weeks });
      const next = nextWeek({ ...draft, weeks });
      return JSON.stringify({
        saved: `week ${week.weekNumber}: ${week.summary.totalHours} h`,
        worthFixing: notes.length ? notes : undefined,
        next: next
          ? `week ${next} (${frames[next - 1].startDate} to ${frames[next - 1].endDate})`
          : "all weeks written - call finish_plan",
      });
    }
    case "finish_plan": {
      const missing = nextWeek(draft);
      if (missing) throw new ValidationError(`Week ${missing} isn't written yet.`);
      const raceDay = Object.values(draft.weeks)
        .flatMap((w) => w.days)
        .find((d) => d.date === draft.form.raceDate);
      if (!raceDay?.workouts.some((w) => w.sport === "race")) {
        throw new ValidationError(
          `Race day (${draft.form.raceDate}) needs the race as a workout (sport "race").`
        );
      }
      updateDraft(draftId, {
        raceStrategy: parseRaceStrategy(input.raceStrategy, draft.form, raceDistanceKm(draft.form)),
        status: "ready",
        error: null,
      });
      return "Plan finished - the athlete can now look it over.";
    }
    default:
      throw new ValidationError(`Unknown tool ${name}`);
  }
}

function withCacheBreakpoint(history: MessageParam[]): MessageParam[] {
  const last = history[history.length - 1];
  if (!last || typeof last.content === "string" || last.content.length === 0) return history;
  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1];
  if (tail.type === "text" || tail.type === "tool_result") {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  }
  return [...history.slice(0, -1), { ...last, content: blocks }];
}

/** Calls left without results (a job cut short) get one, so the conversation stays valid. */
function closeOpenCalls(draft: Draft): void {
  const last = draft.messages[draft.messages.length - 1];
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const calls = last.content.filter(
    (b): b is Anthropic.Beta.Messages.BetaToolUseBlockParam => b.type === "tool_use"
  );
  if (calls.length === 0) return;
  appendDraftMessages(draft.id, [
    {
      role: "user",
      content: calls.map(
        (c): ToolResult => ({
          type: "tool_result",
          tool_use_id: c.id,
          is_error: true,
          content: "Interrupted before this ran.",
        })
      ),
    },
  ]);
}

/**
 * Lets the coach work until it's done with the current step: the
 * assessment submitted (then it waits for the athlete), or the plan
 * finished. Runs in the background; the page polls the draft.
 */
async function work(draftId: number, userId: number): Promise<void> {
  if (running.has(draftId)) return;
  running.add(draftId);
  try {
    let nudges = 0;
    const draft0 = getDraft(userId, draftId)!;
    const maxRounds = weekFrames(draft0.form.startDate, draft0.form.raceDate).length * 2 + 20;
    for (let round = 0; round < maxRounds; round++) {
      const draft = getDraft(userId, draftId)!;
      if (draft.status !== "assessing" && draft.status !== "generating") return;

      const stream = getAnthropic().beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        system: [
          { type: "text", text: PLAN_BUILDER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        tools: TOOLS,
        messages: withCacheBreakpoint(draft.messages),
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        ...(FALLBACK
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        // Tool input that didn't parse: ask again (not an API error).
        if (err instanceof Anthropic.APIError || nudges++ >= 3) throw err;
        continue;
      }
      recordUsage(userId, message.model, message.usage);
      appendDraftMessages(draftId, [
        { role: "assistant", content: message.content as unknown as ContentBlockParam[] },
      ]);

      if (message.stop_reason === "refusal")
        throw new Error("The coach declined to write this plan.");
      if (message.stop_reason === "pause_turn") continue;

      const calls = message.content.filter(
        (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use"
      );
      if (calls.length === 0) {
        const now = getDraft(userId, draftId)!;
        if (now.status === "assessing") {
          if (now.assessment) {
            updateDraft(draftId, { status: "awaiting_confirmation", error: null });
            return;
          }
          if (nudges++ >= 2) throw new Error("The coach didn't produce an assessment.");
          appendDraftMessages(draftId, [
            { role: "user", content: "Please submit your assessment with submit_assessment." },
          ]);
          continue;
        }
        if (now.status === "ready") return;
        // Stopped mid-plan: tell it what's left.
        if (nudges++ >= 3) throw new Error("The coach stopped before finishing the plan.");
        const next = nextWeek(now);
        appendDraftMessages(draftId, [
          {
            role: "user",
            content: next
              ? `Keep going: write week ${next} with write_week, then the rest, then finish_plan.`
              : "All weeks are written: call finish_plan with the race strategy.",
          },
        ]);
        continue;
      }

      const truncated = message.stop_reason === "max_tokens";
      const results: ToolResult[] = calls.map((call) => {
        if (truncated) {
          return {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: "Your output was cut off before this call was complete - make it again.",
          };
        }
        try {
          const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<
            string,
            unknown
          >;
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: runTool(draftId, userId, call.name, input),
          };
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          if (!(err instanceof ValidationError))
            console.error(`Plan builder tool ${call.name} failed:`, err);
          return {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: err.message,
          };
        }
      });
      appendDraftMessages(draftId, [{ role: "user", content: results }]);
    }
    throw new Error("The coach took too many steps writing this plan.");
  } catch (err) {
    console.error(`Plan draft ${draftId} failed:`, err);
    updateDraft(draftId, {
      status: "failed",
      error:
        err instanceof Anthropic.APIError
          ? errorMessage(err)
          : err instanceof Error
            ? err.message
            : "Something went wrong.",
    });
  } finally {
    running.delete(draftId);
  }
}

function launch(draftId: number, userId: number): void {
  void work(draftId, userId);
}

// ---------------------------------------------------------------------------
// What the pages do
// ---------------------------------------------------------------------------

export function startAssessment(draftId: number, userId: number, athlete: string): void {
  const draft = getDraft(userId, draftId)!;
  const frames = weekFrames(draft.form.startDate, draft.form.raceDate);
  appendDraftMessages(draftId, [
    {
      role: "user",
      content: formMessage(draft.form, frames, athlete, todayLocal(), hasGarminHistory(userId)),
    },
  ]);
  launch(draftId, userId);
}

export function sendFeedback(draft: Draft, text: string): void {
  if (draft.status !== "awaiting_confirmation")
    throw new ValidationError("The coach isn't waiting for an answer.");
  appendDraftMessages(draft.id, [
    {
      role: "user",
      content: `The athlete would like changes:\n\n${text}\n\nRevise the assessment and submit it again.`,
    },
  ]);
  updateDraft(draft.id, { status: "assessing" });
  launch(draft.id, draft.userId);
}

export function confirmAssessment(draft: Draft): void {
  if (draft.status !== "awaiting_confirmation")
    throw new ValidationError("There's no assessment to confirm.");
  const frames = weekFrames(draft.form.startDate, draft.form.raceDate);
  appendDraftMessages(draft.id, [
    {
      role: "user",
      content: `The athlete confirmed the assessment. Write the plan now: weeks 1 to ${frames.length} with write_week, in order, then finish_plan.`,
    },
  ]);
  updateDraft(draft.id, { status: "generating" });
  launch(draft.id, draft.userId);
}

/** Carries on a job that failed or was cut short, from where it stopped. */
export function retry(draft: Draft): void {
  if (draft.status !== "failed" && !(isStale(draft) && !running.has(draft.id))) {
    throw new ValidationError("Nothing to retry.");
  }
  closeOpenCalls(draft);
  const generating =
    Object.keys(draft.weeks).length > 0 ||
    draft.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("The athlete confirmed")
    );
  appendDraftMessages(draft.id, [
    { role: "user", content: "You were interrupted. Carry on from where you stopped." },
  ]);
  updateDraft(draft.id, { status: generating ? "generating" : "assessing", error: null });
  launch(draft.id, draft.userId);
}

/** A job marked as running that no process is running - the server restarted. */
function isStale(draft: Draft): boolean {
  return (draft.status === "assessing" || draft.status === "generating") && !running.has(draft.id);
}

export function draftView(draft: Draft): DraftView {
  if (isStale(draft)) {
    updateDraft(draft.id, {
      status: "failed",
      error: "The coach was interrupted. Press Retry to carry on.",
    });
    draft = {
      ...draft,
      status: "failed",
      error: "The coach was interrupted. Press Retry to carry on.",
    };
  }
  const frames = weekFrames(draft.form.startDate, draft.form.raceDate);
  return {
    id: draft.id,
    status: draft.status,
    form: draft.form,
    assessment: draft.assessment,
    totalWeeks: frames.length,
    weeks: Object.values(draft.weeks).sort((a, b) => a.weekNumber - b.weekNumber),
    error: draft.error,
    planId: draft.planId,
    running: running.has(draft.id),
  };
}

function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "plan"
  );
}

/** Saves the finished plan as one of the athlete's plans. */
export function adopt(draft: Draft, athlete: string): string {
  if (draft.status !== "ready" || !draft.assessment || !draft.raceStrategy) {
    throw new ValidationError("The plan isn't finished yet.");
  }
  const frames = weekFrames(draft.form.startDate, draft.form.raceDate);
  const now = new Date().toISOString();
  const id = `${slug(draft.form.raceName)}-${draft.form.raceDate}-${draft.id}`;
  const zones = structuredClone(draft.assessment.zones);
  if (zones.run?.pace) {
    // The race prediction reads the goal from here (lib/racePrediction.ts).
    (zones.run.pace as unknown as Record<string, unknown>).goalTime = draft.assessment.goalTime;
  }
  const plan: TrainingPlan = {
    version: "1.0",
    meta: {
      id,
      athlete,
      event: draft.form.raceName,
      eventDate: draft.form.raceDate,
      planStartDate: frames[0].startDate,
      planEndDate: draft.form.raceDate,
      createdAt: now,
      updatedAt: now,
      totalWeeks: frames.length,
      generatedBy: "Claude Coach (online)",
    },
    preferences: {
      swim: "meters",
      bike: draft.form.units,
      run: draft.form.units,
      firstDayOfWeek: "monday",
    },
    assessment: draft.assessment.assessment,
    zones,
    phases: draft.assessment.phases,
    weeks: frames.map((f) => draft.weeks[f.weekNumber]),
    raceStrategy: draft.raceStrategy,
  };
  importPlanForUser(draft.userId, plan);
  resetAutoCompletions(draft.userId, id);
  autoCompleteFromActivities(draft.userId, [id]);
  updateDraft(draft.id, { status: "adopted", planId: id });
  return id;
}
