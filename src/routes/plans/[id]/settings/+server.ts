import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { updatePlanSettings } from "$lib/server/planMutations.js";
import {
  parsePreferences,
  parseZones,
  readJsonBody,
  ValidationError,
} from "$lib/server/validation.js";

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  try {
    const body = (await readJsonBody(request)) as { preferences?: unknown; zones?: unknown } | null;
    if (!body?.preferences || !body.zones) {
      throw new ValidationError("preferences and zones are required");
    }
    updatePlanSettings(plan, {
      preferences: parsePreferences(body.preferences),
      zones: parseZones(body.zones),
    });
  } catch (err) {
    if (err instanceof ValidationError) throw error(400, err.message);
    throw err;
  }

  savePlanForUser(params.id, userId, plan);
  return json({ ok: true });
};
