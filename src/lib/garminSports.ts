import type { Sport } from "../schema/training-plan.js";

/**
 * Which sports the Garmin bridge can build a structured workout for.
 * Shared between the server (src/lib/server/garminConnect.ts, which builds
 * the actual payload) and the client (WorkoutModal.svelte, which uses this
 * to decide whether to show the "Send to Garmin" button at all).
 */
const GARMIN_SUPPORTED_SPORTS: ReadonlySet<Sport> = new Set(["run", "bike", "swim"]);

export function isGarminConnectSupported(sport: Sport): boolean {
  return GARMIN_SUPPORTED_SPORTS.has(sport);
}
