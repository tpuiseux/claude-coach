import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import {
  toggleWorkoutComplete,
  moveWorkout,
  editWorkout,
  deleteWorkout,
} from "$lib/server/planMutations.js";
import { isIsoDate, parseWorkoutUpdates, readJsonBody } from "$lib/server/validation.js";

interface MutationBody {
  action?: unknown;
  newDate?: unknown;
  updates?: unknown;
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  try {
    const body = ((await readJsonBody(request)) ?? {}) as MutationBody;
    if (body.action === "toggle-complete") {
      toggleWorkoutComplete(plan, params.workoutId);
    } else if (body.action === "move") {
      if (!isIsoDate(body.newDate)) throw new Error("newDate must be a YYYY-MM-DD string");
      moveWorkout(plan, params.workoutId, body.newDate);
    } else if (body.action === "edit") {
      editWorkout(plan, params.workoutId, parseWorkoutUpdates(body.updates));
    } else {
      throw new Error("Unknown action");
    }
  } catch (err) {
    if (err instanceof Error) throw error(400, err.message);
    throw err;
  }

  savePlanForUser(params.id, userId, plan);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  try {
    deleteWorkout(plan, params.workoutId);
  } catch (err) {
    if (err instanceof Error) throw error(400, err.message);
    throw err;
  }

  savePlanForUser(params.id, userId, plan);
  return json({ ok: true });
};
