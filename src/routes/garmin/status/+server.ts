import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isGarminConnected } from "$lib/server/garminCredentials.js";

export const GET: RequestHandler = async ({ locals }) => {
  const userId = locals.user!.id;
  return json({ connected: isGarminConnected(userId) });
};
