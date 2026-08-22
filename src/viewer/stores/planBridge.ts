/**
 * Local config for the plan-save bridge connection (URL + bearer token).
 *
 * Mirrors stores/garminBridge.ts: infrastructure config, not training data,
 * kept in localStorage only so the public page source never contains a
 * token.
 */

export interface PlanBridgeConfig {
  url: string;
  token: string;
}

const STORAGE_KEY = "plan-bridge-config";

const defaults: PlanBridgeConfig = { url: "", token: "" };

export function loadPlanBridgeConfig(): PlanBridgeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function savePlanBridgeConfig(config: PlanBridgeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
