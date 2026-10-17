import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { coachConfigured } from "$lib/server/coach/agent.js";
import { PLAN_DAILY_LIMIT, startAssessment } from "$lib/server/planBuilder/builder.js";
import { parsePlanForm } from "$lib/server/planBuilder/form.js";
import { createDraft, draftsToday } from "$lib/server/planBuilder/store.js";
import { readJsonBody, ValidationError } from "$lib/server/validation.js";
import { todayLocal } from "$lib/server/weekReview.js";

/** Starts a plan from the form: the coach begins with its assessment. */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = locals.user!;
  if (!coachConfigured()) throw error(503, "The coach isn't set up on this server.");
  if (draftsToday(user.id) >= PLAN_DAILY_LIMIT) {
    throw error(429, `That's ${PLAN_DAILY_LIMIT} plans started today - try again tomorrow.`);
  }
  let form;
  try {
    form = parsePlanForm(await readJsonBody(request), todayLocal());
  } catch (err) {
    if (err instanceof ValidationError) throw error(400, err.message);
    throw err;
  }
  const draftId = createDraft(user.id, form);
  startAssessment(draftId, user.id, user.name || user.email.split("@")[0]);
  return json({ draftId });
};
