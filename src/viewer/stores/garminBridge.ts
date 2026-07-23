/**
 * Local config for the Garmin bridge connection (URL + bearer token).
 *
 * Deliberately separate from stores/settings.ts: this isn't training data,
 * it's per-browser infrastructure config, and it must never be baked into
 * the built HTML — it's entered once by the athlete and kept in
 * localStorage only, so the public page source never contains a token.
 */

export interface GarminBridgeConfig {
  url: string;
  token: string;
}

const STORAGE_KEY = "garmin-bridge-config";

const defaults: GarminBridgeConfig = { url: "", token: "" };

export function loadGarminBridgeConfig(): GarminBridgeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveGarminBridgeConfig(config: GarminBridgeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
