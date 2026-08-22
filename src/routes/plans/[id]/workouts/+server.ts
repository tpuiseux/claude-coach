import { randomUUID } from "crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { addWorkout } from "$lib/server/planMutations.js";
import type { Workout } from "../../../../schema/training-plan.js";

interface CreateWorkoutBody {
  date: string;
  workout: Omit<Workout, "id" | "completed">;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  const body = (await request.json()) as CreateWorkoutBody;
  if (!body.date || !body.workout) {
    throw error(400, "date and workout are required");
  }

  const workout: Workout = { ...body.workout, id: `user-${randomUUID()}`, completed: false };

  try {
    addWorkout(plan, body.date, workout);
  } catch (err) {
    if (err instanceof Error) throw error(400, err.message);
    throw err;
  }

  savePlanForUser(params.id, userId, plan);
  return json({ ok: true, workoutId: workout.id });
};
