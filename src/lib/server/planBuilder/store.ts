import type Anthropic from "@anthropic-ai/sdk";
import { get, run } from "../../../db/client.js";
import type { RaceStrategy, TrainingWeek } from "../../../schema/training-plan.js";
import type { DraftStatus, PlanAssessment, PlanForm } from "../../planDraft.js";

/** Plan drafts in the database (plan_drafts in schema.ts). */

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export interface Draft {
  id: number;
  userId: number;
  status: DraftStatus;
  form: PlanForm;
  assessment: PlanAssessment | null;
  weeks: Record<number, TrainingWeek>;
  raceStrategy: RaceStrategy | null;
  messages: MessageParam[];
  error: string | null;
  planId: string | null;
  updatedAt: string;
}

interface DraftRow {
  id: number;
  user_id: number;
  status: DraftStatus;
  form: string;
  assessment: string | null;
  weeks: string;
  race_strategy: string | null;
  messages: string;
  error: string | null;
  plan_id: string | null;
  updated_at: string;
}

function toDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    form: JSON.parse(r.form),
    assessment: r.assessment ? JSON.parse(r.assessment) : null,
    weeks: JSON.parse(r.weeks),
    raceStrategy: r.race_strategy ? JSON.parse(r.race_strategy) : null,
    messages: JSON.parse(r.messages),
    error: r.error,
    planId: r.plan_id,
    updatedAt: r.updated_at,
  };
}

export function createDraft(userId: number, form: PlanForm): number {
  const result = run("INSERT INTO plan_drafts (user_id, status, form) VALUES (?, 'assessing', ?)", [
    userId,
    JSON.stringify(form),
  ]);
  return Number(result.lastInsertRowid);
}

export function getDraft(userId: number, id: number): Draft | null {
  const row = get<DraftRow>("SELECT * FROM plan_drafts WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? toDraft(row) : null;
}

export function draftsToday(userId: number): number {
  return (
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM plan_drafts WHERE user_id = ? AND created_at >= datetime('now', '-1 day')",
      [userId]
    )?.n ?? 0
  );
}

export function updateDraft(
  id: number,
  fields: Partial<{
    status: DraftStatus;
    assessment: PlanAssessment;
    weeks: Record<number, TrainingWeek>;
    raceStrategy: RaceStrategy;
    error: string | null;
    planId: string;
  }>
): void {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  const add = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (fields.status !== undefined) add("status", fields.status);
  if (fields.assessment !== undefined) add("assessment", JSON.stringify(fields.assessment));
  if (fields.weeks !== undefined) add("weeks", JSON.stringify(fields.weeks));
  if (fields.raceStrategy !== undefined) add("race_strategy", JSON.stringify(fields.raceStrategy));
  if (fields.error !== undefined) add("error", fields.error);
  if (fields.planId !== undefined) add("plan_id", fields.planId);
  sets.push("updated_at = datetime('now')");
  run(`UPDATE plan_drafts SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
}

/** Adds messages to the draft's conversation - never rewrites earlier ones. */
export function appendDraftMessages(id: number, messages: MessageParam[]): void {
  const row = get<{ messages: string }>("SELECT messages FROM plan_drafts WHERE id = ?", [id]);
  if (!row) return;
  const all = [...(JSON.parse(row.messages) as MessageParam[]), ...messages];
  run("UPDATE plan_drafts SET messages = ?, updated_at = datetime('now') WHERE id = ?", [
    JSON.stringify(all),
    id,
  ]);
}
