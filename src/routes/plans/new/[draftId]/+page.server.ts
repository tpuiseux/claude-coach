import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { draftView } from "$lib/server/planBuilder/builder.js";
import { getDraft } from "$lib/server/planBuilder/store.js";

export const load: PageServerLoad = async ({ params, locals }) => {
  const draft = getDraft(locals.user!.id, Number(params.draftId));
  if (!draft) throw error(404, "Plan draft not found");
  return { draft: draftView(draft) };
};
