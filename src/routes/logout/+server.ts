import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { RequestHandler } from "./$types";
import { revokeSession } from "../../auth/session.js";
import { SESSION_COOKIE } from "../../hooks.server.js";

export const POST: RequestHandler = async ({ cookies }) => {
  const sessionId = cookies.get(SESSION_COOKIE);
  if (sessionId) revokeSession(sessionId);
  cookies.delete(SESSION_COOKIE, { path: "/" });
  throw redirect(302, `${base}/login`);
};
