import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser } from "$lib/server/plans.js";
import { isGarminConnected } from "$lib/server/garminCredentials.js";
import { buildGarminWorkout, isGarminConnectSupported } from "$lib/server/garminConnect.js";
import { pushWorkoutToGarminBridge } from "$lib/server/garminBridge.js";
import { isIsoDate } from "$lib/server/validation.js";
import type { TrainingPlan } from "../../../../../../schema/training-plan.js";

function findWorkoutWithDate(plan: TrainingPlan, workoutId: string) {
  for (const week of plan.weeks ?? []) {
    for (const day of week.days ?? []) {
      const workout = (day.workouts ?? []).find((w) => w.id === workoutId);
      if (workout) return { workout, date: day.date, weekNumber: week.weekNumber };
    }
  }
  return null;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  const found = findWorkoutWithDate(plan, params.workoutId);
  if (!found) throw error(404, "Workout not found");

  if (!isGarminConnectSupported(found.workout.sport)) {
    throw error(400, `Envoi Garmin non supporte pour le sport "${found.workout.sport}".`);
  }

  if (!isGarminConnected(userId)) {
    throw error(409, "Compte Garmin non connecte. Connecte-le dans les Settings.");
  }

  const payload = buildGarminWorkout(plan, found.workout, found.weekNumber);
  if (!payload) throw error(400, "Impossible de construire la seance Garmin.");

  // An empty/missing body is normal (schedule on the workout's own day);
  // a date that's present but malformed is a client bug worth a 400 rather
  // than forwarding it to Garmin's scheduling API.
  const body = await request.json().catch(() => ({}));
  if (body?.date !== undefined && !isIsoDate(body.date)) {
    throw error(400, "date must be a YYYY-MM-DD string");
  }
  const scheduleDate: string = body?.date ?? found.date;

  const result = await pushWorkoutToGarminBridge(userId, payload, scheduleDate);
  if (!result.ok) throw error(result.status, result.message);

  return json(result.data);
};
