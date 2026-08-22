import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { startGarminLogin } from "$lib/server/garminBridge.js";
import { markGarminConnected } from "$lib/server/garminCredentials.js";

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => null);
  const email = body?.email;
  const password = body?.password;
  if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
    throw error(400, "email et password sont requis");
  }

  const result = await startGarminLogin(userId, email, password);
  if (!result.ok) throw error(result.status, result.message);

  if (!result.data.mfaRequired) {
    markGarminConnected(userId);
  }

  return json({ ok: true, mfaRequired: result.data.mfaRequired });
};
