/**
 * Server-side client for the Garmin bridge's multi-tenant routes
 * (garmin-bridge/garmin_bridge.py's /garmin/* endpoints). Mirrors
 * src/viewer/lib/garminBridge.ts's shape, but talks to the bridge from the
 * SvelteKit server rather than from the browser — the bridge is never
 * reachable from outside the deployment (no nginx route to it), so a
 * user's Garmin session tokens never pass through anything public.
 */

const BRIDGE_URL = process.env.GARMIN_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.GARMIN_BRIDGE_TOKEN || "";

export function isGarminBridgeConfigured(): boolean {
  return !!BRIDGE_URL;
}

interface BridgeError {
  ok: false;
  status: number;
  message: string;
}

async function callBridge<T>(
  path: string,
  init: RequestInit
): Promise<{ ok: true; data: T } | BridgeError> {
  if (!BRIDGE_URL) {
    return { ok: false, status: 503, message: "Le bridge Garmin n'est pas configure." };
  }

  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(BRIDGE_TOKEN ? { Authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    return { ok: false, status: 502, message: "Impossible de joindre le bridge Garmin." };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: (data && data.error) || `Erreur bridge (HTTP ${res.status})`,
    };
  }
  return { ok: true, data: data as T };
}

export async function startGarminLogin(userId: number, email: string, password: string) {
  return callBridge<{ ok: true; mfaRequired: boolean }>("/garmin/login", {
    method: "POST",
    body: JSON.stringify({ userId, email, password }),
  });
}

export async function resumeGarminMfa(userId: number, code: string) {
  return callBridge<{ ok: true }>("/garmin/mfa", {
    method: "POST",
    body: JSON.stringify({ userId, code }),
  });
}

export async function getGarminBridgeStatus(userId: number) {
  return callBridge<{ connected: boolean }>(`/garmin/status?userId=${userId}`, { method: "GET" });
}

export async function disconnectGarminBridge(userId: number) {
  return callBridge<{ ok: true }>("/garmin/disconnect", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export async function pushWorkoutToGarminBridge(
  userId: number,
  workout: Record<string, unknown>,
  date?: string
) {
  return callBridge<{ workoutId: string; scheduled: boolean; date?: string }>(
    "/garmin/push-workout",
    {
      method: "POST",
      body: JSON.stringify({ userId, workout, date }),
    }
  );
}
