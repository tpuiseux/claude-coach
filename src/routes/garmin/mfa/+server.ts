import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resumeGarminMfa } from "$lib/server/garminBridge.js";
import { markGarminConnected } from "$lib/server/garminCredentials.js";

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => null);
  const code = body?.code;
  if (typeof code !== "string" || !code) {
    throw error(400, "code est requis");
  }

  const result = await resumeGarminMfa(userId, code);
  if (!result.ok) throw error(result.status, result.message);

  markGarminConnected(userId);
  return json({ ok: true });
};
