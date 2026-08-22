import type { PageServerLoad } from "./$types";
import { all } from "../db/client.js";

interface PlanRow {
  id: string;
  event: string;
  event_date: string;
  updated_at: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  // locals.user is guaranteed non-null here: hooks.server.ts redirects to
  // /login for every route outside PUBLIC_ROUTES before this ever runs.
  const plans = all<PlanRow>(
    "SELECT id, event, event_date, updated_at FROM plans WHERE user_id = ? ORDER BY event_date",
    [locals.user!.id]
  );

  return { user: locals.user, plans };
};
