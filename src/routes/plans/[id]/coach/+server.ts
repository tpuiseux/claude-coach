import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import type { CoachEvent } from "$lib/coach.js";
import { loadPlanForUser } from "$lib/server/plans.js";
import {
  CoachBusyError,
  CoachLimitError,
  coachConfigured,
  runCoachTurn,
} from "$lib/server/coach/agent.js";
import { conversationView, newConversation } from "$lib/server/coach/store.js";
import { readJsonBody } from "$lib/server/validation.js";

/** The longest message the athlete can send in one go. */
const MAX_MESSAGE_LENGTH = 8000;

function requirePlan(planId: string, userId: number) {
  if (!loadPlanForUser(planId, userId)) throw error(404, "Plan not found");
}

/** The current conversation, as the chat panel shows it. */
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user!.id;
  requirePlan(params.id, userId);
  return json({ configured: coachConfigured(), ...conversationView(userId, params.id) });
};

/** A message to the coach. The reply streams back as NDJSON CoachEvents. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  requirePlan(params.id, userId);
  if (!coachConfigured()) throw error(503, "The coach isn't set up on this server.");

  const body = (await readJsonBody(request).catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) throw error(400, "Write a message first.");
  if (text.length > MAX_MESSAGE_LENGTH) throw error(400, "That message is too long.");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: CoachEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The page went away; the turn stops through the abort signal.
        }
      };
      try {
        await runCoachTurn({ userId, planId: params.id, text, signal: request.signal, emit });
      } catch (err) {
        if (err instanceof CoachBusyError || err instanceof CoachLimitError) {
          emit({ type: "error", message: err.message });
          emit({ type: "done" });
        } else {
          throw err;
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      // nginx would otherwise buffer the reply and it would arrive all at once.
      "X-Accel-Buffering": "no",
    },
  });
};

/** Starts a new conversation; the current one is kept, out of view. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user!.id;
  requirePlan(params.id, userId);
  newConversation(userId, params.id);
  return json({ ok: true });
};
