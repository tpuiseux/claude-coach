import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { updatePlanSettings } from "$lib/server/planMutations.js";
import type { AthleteZones, UnitPreferences } from "../../../../schema/training-plan.js";

interface UpdateSettingsBody {
  preferences: UnitPreferences;
  zones: AthleteZones;
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  const body = (await request.json()) as UpdateSettingsBody;
  if (!body.preferences || !body.zones) {
    throw error(400, "preferences and zones are required");
  }

  updatePlanSettings(plan, body);
  savePlanForUser(params.id, userId, plan);
  return json({ ok: true });
};
