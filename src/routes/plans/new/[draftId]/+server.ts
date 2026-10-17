import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  adopt,
  confirmAssessment,
  draftView,
  retry,
  sendFeedback,
} from "$lib/server/planBuilder/builder.js";
import { getDraft } from "$lib/server/planBuilder/store.js";
import { readJsonBody, ValidationError } from "$lib/server/validation.js";

function load(userId: number, id: string) {
  const draft = getDraft(userId, Number(id));
  if (!draft) throw error(404, "Plan draft not found");
  return draft;
}

/** The draft as it stands - the page polls this while the coach works. */
export const GET: RequestHandler = async ({ params, locals }) => {
  return json(draftView(load(locals.user!.id, params.draftId)));
};

/** The athlete's answer: feedback on the assessment, confirm, retry, or adopt the plan. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const user = locals.user!;
  const draft = load(user.id, params.draftId);
  const body = (await readJsonBody(request).catch(() => null)) as {
    action?: unknown;
    text?: unknown;
  } | null;
  try {
    switch (body?.action) {
      case "feedback": {
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
        if (!text) throw new ValidationError("Say what you'd like changed.");
        sendFeedback(draft, text);
        break;
      }
      case "confirm":
        confirmAssessment(draft);
        break;
      case "retry":
        retry(draft);
        break;
      case "adopt": {
        const planId = adopt(draft, user.name || user.email.split("@")[0]);
        return json({ planId });
      }
      default:
        throw new ValidationError("Unknown action");
    }
  } catch (err) {
    if (err instanceof ValidationError) throw error(409, err.message);
    throw err;
  }
  return json(draftView(load(user.id, params.draftId)));
};
