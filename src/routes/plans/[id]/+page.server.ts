import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { loadPlanForUser } from "$lib/server/plans.js";

export const load: PageServerLoad = async ({ params, locals }) => {
  const plan = loadPlanForUser(params.id, locals.user!.id);
  if (!plan) {
    throw error(404, "Plan not found");
  }
  return { plan };
};
