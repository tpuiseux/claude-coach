import { randomUUID } from "crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { addWorkout } from "$lib/server/planMutations.js";
import { isIsoDate, parseNewWorkout, readJsonBody } from "$lib/server/validation.js";
import type { Workout } from "../../../../schema/training-plan.js";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  let workoutId: string;
  try {
    const body = (await readJsonBody(request)) as { date?: unknown; workout?: unknown } | null;
    if (!isIsoDate(body?.date)) throw new Error("date must be a YYYY-MM-DD string");

    const workout: Workout = {
      ...parseNewWorkout(body.workout),
      id: `user-${randomUUID()}`,
      completed: false,
    };
    workoutId = workout.id;
    addWorkout(plan, body.date, workout);
  } catch (err) {
    if (err instanceof Error) throw error(400, err.message);
    throw err;
  }

  savePlanForUser(params.id, userId, plan);
  return json({ ok: true, workoutId });
};
