/**
 * Client for the local Garmin bridge (scripts/garmin_bridge.py in the plan's
 * project folder). The HTML viewer is a static, offline page, so it cannot
 * talk to Garmin Connect directly — the bridge is a small local server the
 * athlete starts once, and this module just calls it over localhost.
 *
 * The bridge itself is a generic "upload this Garmin workout JSON" pipe; all
 * the plan-schema knowledge (structure, pace zones, etc.) lives here on the
 * client side in export/garmin-connect.ts, same as the FIT/Zwift exporters.
 */

import type { Workout } from "../../schema/training-plan.js";
import { buildGarminWorkout, isGarminConnectSupported } from "./export/garmin-connect.js";

const BRIDGE_URL = "http://127.0.0.1:8420";

export interface GarminPushResult {
  ok: boolean;
  message: string;
}

export { isGarminConnectSupported };

export async function pushWorkoutToGarmin(
  workout: Workout,
  date?: string
): Promise<GarminPushResult> {
  const payload = buildGarminWorkout(workout);
  if (!payload) {
    return { ok: false, message: `Export Garmin non supporte pour le sport "${workout.sport}".` };
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/push-workout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workout: payload, date }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errorMessage = data?.error || `Erreur bridge (HTTP ${res.status})`;
      return { ok: false, message: errorMessage };
    }

    if (data?.workoutId === "dry-run") {
      return { ok: true, message: "Bridge en mode test (--dry-run) : rien envoye a Garmin." };
    }

    return {
      ok: true,
      message: data?.scheduled
        ? `Envoyee et programmee sur Garmin Connect pour le ${data.date}.`
        : "Envoyee dans ta bibliotheque de seances Garmin Connect.",
    };
  } catch {
    return {
      ok: false,
      message:
        "Impossible de joindre le bridge Garmin. Lance 'python3 scripts/garmin_bridge.py' puis reessaie.",
    };
  }
}
