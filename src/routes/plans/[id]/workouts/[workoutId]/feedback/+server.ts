import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { setWorkoutCompleted } from "$lib/server/planMutations.js";
import { deleteFeedback, saveFeedback } from "$lib/server/feedback.js";
import { parseWorkoutFeedback, readJsonBody, ValidationError } from "$lib/server/validation.js";
import type { TrainingPlan } from "../../../../../../schema/training-plan.js";

function hasWorkout(plan: TrainingPlan, workoutId: string): boolean {
  return (plan.weeks ?? []).some((w) =>
    (w.days ?? []).some((d) => (d.workouts ?? []).some((wo) => wo.id === workoutId))
  );
}

/** Records how the workout went. Logging feedback also marks it completed. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");
  if (!hasWorkout(plan, params.workoutId)) throw error(404, "Workout not found");

  let feedback;
  try {
    feedback = parseWorkoutFeedback(await readJsonBody(request));
  } catch (err) {
    if (err instanceof ValidationError) throw error(400, err.message);
    throw err;
  }

  saveFeedback(userId, params.id, params.workoutId, feedback);
  setWorkoutCompleted(plan, params.workoutId, true);
  savePlanForUser(params.id, userId, plan);
  return json({ ok: true });
};

/** Removes the feedback. The workout stays completed - that's a separate toggle. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user!.id;
  if (!loadPlanForUser(params.id, userId)) throw error(404, "Plan not found");
  deleteFeedback(userId, params.id, params.workoutId);
  return json({ ok: true });
};
