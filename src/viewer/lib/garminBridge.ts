/**
 * Client for the Garmin bridge (scripts/garmin_bridge.py). The HTML viewer
 * is a static page — it cannot talk to Garmin Connect or hold credentials
 * itself — so a small server (run locally, or deployed behind your own
 * reverse proxy) does that on its behalf. This module just calls it.
 *
 * The bridge URL and auth token are configured per-browser in Settings and
 * kept in localStorage only (see stores/garminBridge.ts) — never baked into
 * the built HTML, since that file is public.
 *
 * The bridge itself is a generic "upload this Garmin workout JSON" pipe; all
 * the plan-schema knowledge (structure, pace zones, etc.) lives here on the
 * client side in export/garmin-connect.ts, same as the FIT/Zwift exporters.
 */

import type { Workout } from "../../schema/training-plan.js";
import { buildGarminWorkout, isGarminConnectSupported } from "./export/garmin-connect.js";
import { loadGarminBridgeConfig } from "../stores/garminBridge.js";

export interface GarminPushResult {
  ok: boolean;
  message: string;
}

export { isGarminConnectSupported };

export async function checkGarminBridgeHealth(): Promise<GarminPushResult> {
  const { url, token } = loadGarminBridgeConfig();
  if (!url) {
    return { ok: false, message: "Renseigne d'abord l'URL du bridge." };
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, message: `Bridge injoignable (HTTP ${res.status})` };
    }
    if (data?.authRequired && !token) {
      return {
        ok: false,
        message: "Bridge joignable, mais il exige un token que tu n'as pas renseigne.",
      };
    }
    return {
      ok: true,
      message: data?.dryRun
        ? "Bridge joignable (mode --dry-run)."
        : "Bridge joignable et connecte a Garmin.",
    };
  } catch {
    return { ok: false, message: "Impossible de joindre le bridge a cette URL." };
  }
}

export async function pushWorkoutToGarmin(
  workout: Workout,
  date?: string
): Promise<GarminPushResult> {
  const payload = buildGarminWorkout(workout);
  if (!payload) {
    return { ok: false, message: `Export Garmin non supporte pour le sport "${workout.sport}".` };
  }

  const { url, token } = loadGarminBridgeConfig();
  if (!url) {
    return { ok: false, message: "Configure l'URL du bridge Garmin dans les Settings d'abord." };
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/push-workout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ workout: payload, date }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, message: "Non autorise (401) — verifie le token dans les Settings." };
      }
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
        "Impossible de joindre le bridge Garmin. Verifie l'URL dans les Settings et que le bridge tourne.",
    };
  }
}
