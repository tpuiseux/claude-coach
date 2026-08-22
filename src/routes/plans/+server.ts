import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { importPlanForUser, PlanOwnershipError } from "$lib/server/plans.js";
import type { TrainingPlan } from "../../schema/training-plan.js";

/**
 * Minimal shape check on an uploaded plan file - not full schema
 * validation (no zod dependency in this project), just enough to reject
 * obvious garbage before it lands in the DB.
 */
function isPlanShaped(value: unknown): value is TrainingPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<TrainingPlan>;
  return (
    typeof plan.meta?.id === "string" &&
    plan.meta.id.length > 0 &&
    typeof plan.meta?.event === "string" &&
    typeof plan.meta?.eventDate === "string" &&
    typeof plan.meta?.createdAt === "string" &&
    typeof plan.meta?.updatedAt === "string" &&
    Array.isArray(plan.weeks)
  );
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user!.id;

  const form = await request.formData();
  const file = form.get("plan");
  if (!(file instanceof File)) {
    throw error(400, "No file uploaded");
  }

  let plan: unknown;
  try {
    plan = JSON.parse(await file.text());
  } catch {
    throw error(400, "Not valid JSON");
  }

  if (!isPlanShaped(plan)) {
    throw error(400, "Doesn't look like a training plan (missing meta.id/event/eventDate/weeks)");
  }

  try {
    importPlanForUser(userId, plan);
  } catch (err) {
    if (err instanceof PlanOwnershipError) throw error(403, err.message);
    throw err;
  }

  return json({ ok: true, planId: plan.meta.id });
};
