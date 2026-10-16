import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getActivityDetails } from "$lib/server/activityDetails.js";

/** One recorded activity in detail (samples, laps, stats) for the analysis panel. */
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user!.id;
  const activityId = Number(params.id);
  if (!Number.isSafeInteger(activityId) || activityId <= 0) throw error(404, "Activity not found");

  const result = await getActivityDetails(userId, activityId);
  if (!result.ok) throw error(result.status, result.message);
  return json(result.analysis);
};
