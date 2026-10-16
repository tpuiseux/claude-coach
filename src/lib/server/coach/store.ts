import type Anthropic from "@anthropic-ai/sdk";
import { all, get, run } from "../../../db/client.js";
import type {
  ChangePreview,
  CoachChatMessage,
  CoachConversation,
  CoachProposal,
  PlanChange,
  ProposalStatus,
} from "../../coach.js";

/** Coach conversations, messages and proposals in the database (schema.ts). */

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;

/** The user's current conversation about this plan, started if there's none. */
export function currentConversationId(userId: number, planId: string): number {
  const row = get<{ id: number }>(
    "SELECT id FROM coach_conversations WHERE user_id = ? AND plan_id = ? ORDER BY id DESC LIMIT 1",
    [userId, planId]
  );
  return row?.id ?? newConversation(userId, planId);
}

export function newConversation(userId: number, planId: string): number {
  const result = run("INSERT INTO coach_conversations (user_id, plan_id) VALUES (?, ?)", [
    userId,
    planId,
  ]);
  return Number(result.lastInsertRowid);
}

export function appendMessage(
  conversationId: number,
  role: "user" | "assistant",
  content: ContentBlock[]
): number {
  const result = run(
    "INSERT INTO coach_messages (conversation_id, role, content) VALUES (?, ?, ?)",
    [conversationId, role, JSON.stringify(content)]
  );
  return Number(result.lastInsertRowid);
}

interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
}

function messageRows(conversationId: number): MessageRow[] {
  return all<MessageRow>(
    "SELECT id, role, content FROM coach_messages WHERE conversation_id = ? ORDER BY id",
    [conversationId]
  );
}

/** The conversation as the API takes it: every message, unchanged. */
export function loadHistory(conversationId: number): MessageParam[] {
  return messageRows(conversationId).map((r) => ({
    role: r.role,
    content: JSON.parse(r.content) as ContentBlock[],
  }));
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: number;
  message_id: number;
  summary: string;
  changes: string;
  status: ProposalStatus;
  plan_before: string | null;
  applied_version?: string | null;
  created_at: string;
}

interface StoredChanges {
  changes: PlanChange[];
  preview: ChangePreview[];
}

function toProposal(row: ProposalRow): CoachProposal {
  const stored = JSON.parse(row.changes) as StoredChanges;
  return {
    id: row.id,
    summary: row.summary,
    changes: stored.preview,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createProposal(
  conversationId: number,
  messageId: number,
  userId: number,
  planId: string,
  summary: string,
  changes: PlanChange[],
  preview: ChangePreview[]
): CoachProposal {
  const result = run(
    `INSERT INTO coach_proposals (conversation_id, message_id, user_id, plan_id, summary, changes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [conversationId, messageId, userId, planId, summary, JSON.stringify({ changes, preview })]
  );
  return getProposal(userId, planId, Number(result.lastInsertRowid))!.proposal;
}

export function getProposal(
  userId: number,
  planId: string,
  id: number
): {
  proposal: CoachProposal;
  changes: PlanChange[];
  planBefore: string | null;
  appliedVersion: string | null;
} | null {
  const row = get<ProposalRow>(
    `SELECT id, message_id, summary, changes, status, plan_before, applied_version, created_at
     FROM coach_proposals WHERE id = ? AND user_id = ? AND plan_id = ?`,
    [id, userId, planId]
  );
  if (!row) return null;
  return {
    proposal: toProposal(row),
    changes: (JSON.parse(row.changes) as StoredChanges).changes,
    planBefore: row.plan_before,
    appliedVersion: row.applied_version ?? null,
  };
}

export function setProposalStatus(
  id: number,
  status: ProposalStatus,
  applied?: { planBefore: string; version: string }
): void {
  run(
    `UPDATE coach_proposals SET status = ?, reported = 0, resolved_at = datetime('now')
       ${applied ? ", plan_before = ?, applied_version = ?" : ""}
     WHERE id = ?`,
    applied ? [status, applied.planBefore, applied.version, id] : [status, id]
  );
}

/**
 * What the athlete did with proposals since the coach last heard - told to
 * the coach with their next message, so it doesn't assume a change it
 * proposed is in the plan, or that one they undid still is.
 */
export function takeProposalNews(conversationId: number): string | null {
  const rows = all<{ id: number; summary: string; status: ProposalStatus }>(
    `SELECT id, summary, status FROM coach_proposals
     WHERE conversation_id = ? AND reported = 0 AND status != 'pending' ORDER BY id`,
    [conversationId]
  );
  if (rows.length === 0) return null;
  run(`UPDATE coach_proposals SET reported = 1 WHERE conversation_id = ? AND status != 'pending'`, [
    conversationId,
  ]);
  const verbs: Record<ProposalStatus, string> = {
    pending: "has not answered",
    applied: "applied",
    rejected: "rejected",
    undone: "applied, then undid",
  };
  return rows
    .map((r) => `The athlete ${verbs[r.status]} proposal #${r.id} (${r.summary}).`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// The conversation as the chat panel shows it
// ---------------------------------------------------------------------------

/** Text blocks the app adds to the athlete's messages for the coach only. */
export const CONTEXT_TAG = "app-context";

export function conversationView(userId: number, planId: string): CoachConversation {
  const conversationId = currentConversationId(userId, planId);
  const proposalRows = all<ProposalRow>(
    `SELECT id, message_id, summary, changes, status, plan_before, created_at
     FROM coach_proposals WHERE conversation_id = ? ORDER BY id`,
    [conversationId]
  );

  const messages: CoachChatMessage[] = [];
  // Which bubble each stored message ended up in, to place proposals.
  const bubbleOf = new Map<number, CoachChatMessage>();
  for (const row of messageRows(conversationId)) {
    const blocks = JSON.parse(row.content) as ContentBlock[];
    const text = blocks
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlockParam => b.type === "text")
      .map((b) => b.text)
      .filter((t) => !t.startsWith(`<${CONTEXT_TAG}>`))
      .join("\n\n");

    if (row.role === "user") {
      // Tool results ride in user messages; they're not the athlete talking.
      if (text) messages.push({ id: row.id, role: "user", text, activity: [], proposalIds: [] });
      continue;
    }

    // One assistant bubble per reply, however many tool round trips it took.
    let bubble = messages[messages.length - 1];
    if (bubble?.role !== "assistant") {
      bubble = { id: row.id, role: "assistant", text: "", activity: [], proposalIds: [] };
      messages.push(bubble);
    }
    bubbleOf.set(row.id, bubble);
    if (text) bubble.text = bubble.text ? `${bubble.text}\n\n${text}` : text;
    for (const b of blocks) {
      if (b.type === "tool_use") bubble.activity.push(b.name);
    }
  }

  for (const row of proposalRows) bubbleOf.get(row.message_id)?.proposalIds.push(row.id);
  return { messages, proposals: proposalRows.map(toProposal) };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function recordUsage(
  userId: number,
  model: string,
  usage: Anthropic.Beta.Messages.BetaUsage
) {
  run(
    `INSERT INTO coach_usage (user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
    ]
  );
}

/** Messages the athlete sent the coach in the last 24 hours. */
export function messagesToday(userId: number): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM coach_messages m
       JOIN coach_conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.role = 'user' AND m.created_at >= datetime('now', '-1 day')
         AND m.content NOT LIKE '[{"type":"tool_result"%'`,
      [userId]
    )?.n ?? 0
  );
}
