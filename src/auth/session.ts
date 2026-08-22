import { randomBytes } from "crypto";
import { get, run } from "../db/client.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  id: string;
  user_id: number;
  expires_at: string;
}

/** Creates a session row and returns its id - the value to set as the session cookie. */
export function createSession(userId: number): string {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [id, userId, expiresAt]);
  return id;
}

/** Returns the session's user id if valid, or null if missing/expired (expired rows are deleted). */
export function validateSession(sessionId: string): number | null {
  const session = get<Session>("SELECT id, user_id, expires_at FROM sessions WHERE id = ?", [
    sessionId,
  ]);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    revokeSession(sessionId);
    return null;
  }

  return session.user_id;
}

export function revokeSession(sessionId: string): void {
  run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

/** Logs the user out everywhere - used e.g. after a password change. */
export function revokeAllSessionsForUser(userId: number): void {
  run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}
