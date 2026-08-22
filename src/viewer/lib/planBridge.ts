/**
 * Client for the plan-save bridge (scripts/plan_bridge.py). The HTML viewer
 * is a static page — it can't write to its own source files — so a small
 * server (see plan_bridge.py) does that on its behalf. This module merges
 * local changes into the plan (same logic as the "Export" button) and POSTs
 * the result; the bridge writes it to the plan's .json/.html files in
 * place.
 *
 * Mirrors lib/garminBridge.ts's shape and error handling.
 */

import type { TrainingPlan } from "../../schema/training-plan.js";
import { applyLocalChangesToPlan, type PlanChanges } from "./UpdatePlan.js";
import { loadPlanBridgeConfig } from "../stores/planBridge.js";

export interface PlanBridgeResult {
  ok: boolean;
  message: string;
  savedAt?: string;
}

export async function checkPlanBridgeHealth(): Promise<PlanBridgeResult> {
  const { url, token } = loadPlanBridgeConfig();
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
        ? "Bridge joignable (mode --dry-run, rien n'est ecrit)."
        : "Bridge joignable, pret a sauvegarder.",
    };
  } catch {
    return { ok: false, message: "Impossible de joindre le bridge a cette URL." };
  }
}

export async function saveToPlanBridge(
  plan: TrainingPlan,
  changes: PlanChanges,
  completed: Record<string, boolean>
): Promise<PlanBridgeResult> {
  const { url, token } = loadPlanBridgeConfig();
  if (!url) {
    return { ok: false, message: "Configure l'URL du bridge dans les Settings d'abord." };
  }

  const updatedPlan = applyLocalChangesToPlan(plan, changes, completed);

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/save-plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ plan: updatedPlan }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, message: "Non autorise (401) — verifie le token dans les Settings." };
      }
      if (res.status === 403) {
        return {
          ok: false,
          message: data?.error || "Ce plan n'est pas enregistre sur le bridge (403).",
        };
      }
      return { ok: false, message: data?.error || `Erreur bridge (HTTP ${res.status})` };
    }

    if (data?.dryRun) {
      return { ok: true, message: "Bridge en mode test (--dry-run) : rien ecrit sur le disque." };
    }

    return {
      ok: true,
      message: "Enregistre sur le serveur.",
      savedAt: data?.savedAt,
    };
  } catch {
    return {
      ok: false,
      message: "Impossible de joindre le bridge. Verifie l'URL dans les Settings.",
    };
  }
}
