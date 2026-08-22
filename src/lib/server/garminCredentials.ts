import { get, run } from "../../db/client.js";

/**
 * The garmin_credentials row is a connection marker, not a real credential
 * store — tokenstore_path is informational only (the Garmin bridge derives
 * its own per-user tokenstore file from the numeric user id; the web app
 * never reads or writes Garmin session tokens itself).
 */

export function isGarminConnected(userId: number): boolean {
  return !!get("SELECT user_id FROM garmin_credentials WHERE user_id = ?", [userId]);
}

export function markGarminConnected(userId: number): void {
  run(
    `INSERT INTO garmin_credentials (user_id, tokenstore_path)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET connected_at = datetime('now')`,
    [userId, `multiuser:${userId}`]
  );
}

export function markGarminDisconnected(userId: number): void {
  run("DELETE FROM garmin_credentials WHERE user_id = ?", [userId]);
}
