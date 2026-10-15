import { base } from "$app/paths";

/** Browser side of /garmin/sync (see lib/server/garminSync.ts). */

export interface SyncState {
  status: "running" | "success" | "failed";
  last_success_at: string | null;
  activities_synced: number | null;
  wellness_days_synced: number | null;
  error: string | null;
}

export interface SyncStatus {
  connected: boolean;
  state: SyncState | null;
}

const POLL_MS = 3000;
// Wellness costs ~6 Garmin calls per day and Garmin rate-limits with
// backoffs of up to a minute, so a first sync can legitimately take minutes.
const MAX_POLLS = 100;

export async function getSyncStatus(): Promise<SyncStatus> {
  const res = await fetch(`${base}/garmin/sync`);
  if (!res.ok) throw new Error(`Sync status unavailable (${res.status})`);
  return res.json();
}

/**
 * Starts a sync (a no-op server-side when the last one is recent, unless
 * forced) and resolves with the final state once it's no longer running, or
 * null if nothing was started. `onStarted` fires only if a sync is actually
 * underway, so callers can show progress without flashing it on every call.
 */
export async function runSync(force: boolean, onStarted?: () => void): Promise<SyncState | null> {
  const res = await fetch(`${base}/garmin/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  if (!res.ok) throw new Error(`Couldn't start the sync (${res.status})`);
  const { result } = (await res.json()) as { result: string };
  if (result !== "started" && result !== "running") return null;
  onStarted?.();

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { state } = await getSyncStatus();
    if (state && state.status !== "running") return state;
  }
  return null;
}
