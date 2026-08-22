import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { disconnectGarminBridge } from "$lib/server/garminBridge.js";
import { markGarminDisconnected } from "$lib/server/garminCredentials.js";

export const POST: RequestHandler = async ({ locals }) => {
  const userId = locals.user!.id;
  // Best-effort: still clear our own connection marker even if the bridge
  // call fails (e.g. bridge briefly down) - the user asked to disconnect,
  // so the UI should reflect that regardless of whether the token file on
  // the bridge got cleaned up.
  await disconnectGarminBridge(userId).catch(() => null);
  markGarminDisconnected(userId);
  return json({ ok: true });
};
