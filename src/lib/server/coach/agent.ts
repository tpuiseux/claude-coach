import Anthropic from "@anthropic-ai/sdk";
import type { CoachEvent } from "../../coach.js";
import { ValidationError } from "../validation.js";
import { COACH_SYSTEM_PROMPT } from "./prompt.js";
import {
  appendMessage,
  CONTEXT_TAG,
  currentConversationId,
  loadHistory,
  messagesToday,
  recordUsage,
  takeProposalNews,
} from "./store.js";
import { COACH_TOOLS, runCoachTool, TOOL_LABELS } from "./tools.js";

/**
 * One exchange with the coach: the athlete's message in, the coach's reply
 * streamed out, with as many tool round trips as the coach needs in between.
 * Every message is stored as it happens, exactly as the API returned it -
 * the conversation is append-only, which the API requires for the model's
 * thinking to carry over from one turn to the next.
 */

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const MODEL = process.env.COACH_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.COACH_EFFORT || "medium") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
const DAILY_LIMIT = Number(process.env.COACH_DAILY_LIMIT || 40);
const TIME_ZONE = process.env.COACH_TIMEZONE || "Europe/Paris";
/** Tool round trips in one reply before the coach has to answer. */
const MAX_ROUNDS = 12;
/** Server-side fallback when a safety classifier declines: these models take it. */
const FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(MODEL);

// Tools stream their input as it's generated; runCoachTool validates it.
const TOOLS = COACH_TOOLS.map((t) => ({ ...t, eager_input_streaming: true }));

let client: Anthropic | null = null;

export function coachConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** One reply at a time per athlete and plan. */
const running = new Set<string>();

export class CoachBusyError extends Error {}
export class CoachLimitError extends Error {}

function today(): string {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
  const weekday = now.toLocaleDateString("en-GB", { timeZone: TIME_ZONE, weekday: "long" });
  return `${weekday} ${date}`;
}

/**
 * A reply cut off between a tool call and its result (the athlete closed
 * the page) leaves calls without results, which the API rejects. Answer
 * them as interrupted - appended, never rewritten.
 */
function closeInterruptedCalls(conversationId: number, history: MessageParam[]): void {
  const last = history[history.length - 1];
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const calls = last.content.filter(
    (b): b is Anthropic.Beta.Messages.BetaToolUseBlockParam => b.type === "tool_use"
  );
  if (calls.length === 0) return;
  appendMessage(
    conversationId,
    "user",
    calls.map(
      (c): ToolResult => ({
        type: "tool_result",
        tool_use_id: c.id,
        is_error: true,
        content: "Interrupted before this ran.",
      })
    )
  );
}

/** The history with a cache breakpoint on its last block, so the next round
 * (and the next message) reads everything before it from the cache. */
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

function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The coach's API key was refused.";
  if (err instanceof Anthropic.RateLimitError)
    return "The coach is busy right now - try again in a minute.";
  if (err instanceof Anthropic.APIError) {
    return err.status && err.status >= 500
      ? "The coach's service is having trouble - try again shortly."
      : `The coach couldn't answer (${err.status ?? "error"}).`;
  }
  return "Something went wrong with the coach.";
}

export async function runCoachTurn(options: {
  userId: number;
  planId: string;
  text: string;
  signal: AbortSignal;
  emit: (event: CoachEvent) => void;
}): Promise<void> {
  const { userId, planId, text, signal, emit } = options;
  const key = `${userId}:${planId}`;
  if (running.has(key)) throw new CoachBusyError("The coach is still answering your last message.");
  if (messagesToday(userId) >= DAILY_LIMIT) {
    throw new CoachLimitError(
      `That's ${DAILY_LIMIT} messages in 24 hours - the coach will be back tomorrow.`
    );
  }

  running.add(key);
  try {
    const conversationId = currentConversationId(userId, planId);
    closeInterruptedCalls(conversationId, loadHistory(conversationId));

    const news = takeProposalNews(conversationId);
    appendMessage(conversationId, "user", [
      {
        type: "text",
        text: `<${CONTEXT_TAG}>Today is ${today()}.${news ? ` ${news}` : ""}</${CONTEXT_TAG}>`,
      },
      { type: "text", text },
    ]);

    let wroteText = false;
    let jsonRetries = 0;
    let answered = false;
    for (let round = 0; round < MAX_ROUNDS && !answered; round++) {
      let roundStarted = false;
      const stream = getClient().beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 32000,
          system: [
            { type: "text", text: COACH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          tools: TOOLS,
          messages: withCacheBreakpoint(loadHistory(conversationId)),
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT },
          ...(FALLBACK
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        },
        { signal }
      );
      stream.on("text", (delta) => {
        // Text from successive rounds reads as separate paragraphs.
        if (!roundStarted && wroteText) emit({ type: "text", delta: "\n\n" });
        roundStarted = true;
        wroteText = true;
        emit({ type: "text", delta });
      });

      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // A tool input that didn't parse at all: ask again, a couple of times.
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }
      recordUsage(userId, message.model, message.usage);
      const messageId = appendMessage(
        conversationId,
        "assistant",
        message.content as unknown as ContentBlockParam[]
      );

      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "The coach can't help with that one." });
        answered = true;
        break;
      }
      if (message.stop_reason === "pause_turn") continue;

      const calls = message.content.filter(
        (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use"
      );
      if (calls.length === 0) {
        if (message.stop_reason === "max_tokens") {
          emit({ type: "error", message: "The reply was cut short - ask the coach to continue." });
        }
        answered = true;
        break;
      }

      // A call cut off at max_tokens may parse as a truncated object: don't run it.
      const truncated = message.stop_reason === "max_tokens";
      const results: ToolResult[] = [];
      for (const call of calls) {
        if (truncated) {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content:
              "Your output was cut off before this call was complete - make it again, shorter.",
          });
          continue;
        }
        emit({ type: "activity", label: TOOL_LABELS[call.name] ?? call.name });
        try {
          const content = await runCoachTool(
            {
              userId,
              planId,
              conversationId,
              messageId,
              onProposal: (proposal) => emit({ type: "proposal", proposal }),
            },
            call.name,
            call.input
          );
          results.push({ type: "tool_result", tool_use_id: call.id, content });
        } catch (err) {
          // Bad input or a failed lookup goes back to the coach to deal with.
          if (!(err instanceof Error)) throw err;
          if (!(err instanceof ValidationError))
            console.error(`Coach tool ${call.name} failed:`, err);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: err.message,
          });
        }
      }
      appendMessage(conversationId, "user", results);
    }
    if (!answered) {
      emit({ type: "error", message: "The coach went round in circles - try asking differently." });
    }
    emit({ type: "done" });
  } catch (err) {
    if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
    console.error("Coach turn failed:", err);
    emit({ type: "error", message: errorMessage(err) });
  } finally {
    running.delete(key);
  }
}
