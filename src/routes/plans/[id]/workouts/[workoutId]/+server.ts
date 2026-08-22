import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import {
  toggleWorkoutComplete,
  moveWorkout,
  editWorkout,
  deleteWorkout,
} from "$lib/server/planMutations.js";
import type { Workout } from "../../../../../schema/training-plan.js";

type MutationBody =
  | { action: "toggle-complete" }
  | { action: "move"; newDate: string }
  | { action: "edit"; updates: Partial<Workout> };

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  const body = (await request.json()) as MutationBody;

  try {
    if (body.action === "toggle-complete") {
      toggleWorkoutComplete(plan, params.workoutId);
    } else if (body.action === "move") {
      if (!body.newDate) throw error(400, "newDate is required");
      moveWorkout(plan, params.workoutId, body.newDate);
    } else if (body.action === "edit") {
      editWorkout(plan, params.workoutId, body.updates);
    } else {
      throw error(400, "Unknown action");
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
