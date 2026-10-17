import type { PageServerLoad } from "./$types";
import { coachConfigured } from "$lib/server/coach/agent.js";
import { addDays, nextMonday } from "$lib/server/planBuilder/form.js";
import { todayLocal } from "$lib/server/weekReview.js";

export const load: PageServerLoad = async () => {
  const today = todayLocal();
  return { configured: coachConfigured(), today, startDate: nextMonday(addDays(today, 1)) };
};
