import type { Cookies } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { createSession } from "../../auth/session.js";
import { SESSION_COOKIE } from "../../hooks.server.js";

/** Opens a session for the user and sets its cookie - the shared last step
 * of logging in and of signing up. */
export function startSession(cookies: Cookies, userId: number): void {
  cookies.set(SESSION_COOKIE, createSession(userId), {
    path: "/",
    httpOnly: true,
    secure: !dev,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // matches SESSION_TTL_MS in auth/session.ts
  });
}
