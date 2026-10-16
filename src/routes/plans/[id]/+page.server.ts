import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { loadPlanForUser } from "$lib/server/plans.js";
import { getActivitiesByDate } from "$lib/server/activities.js";
import { getFeedbackForPlan } from "$lib/server/feedback.js";
import { getRacePrediction } from "$lib/server/racePrediction.js";
import { getWeekReviews } from "$lib/server/weekReview.js";
import { getLoadSeries } from "$lib/server/load.js";

export const load: PageServerLoad = async ({ params, locals }) => {
  const userId = locals.user!.id;
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) {
    throw error(404, "Plan not found");
  }

  const dates = (plan.weeks ?? []).flatMap((w) => (w.days ?? []).map((d) => d.date)).sort();
  const activitiesByDate =
    dates.length > 0 ? getActivitiesByDate(userId, dates[0], dates[dates.length - 1]) : {};

  const feedback = getFeedbackForPlan(userId, params.id);
  return {
    plan,
    activitiesByDate,
    feedback,
    prediction: getRacePrediction(userId, plan),
    weekReviews: getWeekReviews(userId, params.id, plan, activitiesByDate, feedback),
    load: getLoadSeries(userId, plan),
  };
};
