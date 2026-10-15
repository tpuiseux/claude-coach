import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isGarminConnected } from "$lib/server/garminCredentials.js";
import { effectiveSyncState, startGarminSync } from "$lib/server/garminSync.js";

/** Current sync state - polled by the UI while a sync runs. */
export const GET: RequestHandler = async ({ locals }) => {
  const userId = locals.user!.id;
  return json({ connected: isGarminConnected(userId), state: effectiveSyncState(userId) });
};

/**
 * Starts a background sync. {force: true} syncs even if the last one is
 * recent (the "Sync now" button); without it this is a cheap no-op when
 * fresh, so the plan page calls it on every load.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => ({}));
  const result = startGarminSync(userId, { force: body?.force === true });
  return json({ result, state: effectiveSyncState(userId) });
};
