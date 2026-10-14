import { fail, redirect } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { base } from "$app/paths";
import type { Actions } from "./$types";
import { verifyLogin } from "../../auth/users.js";
import { createSession } from "../../auth/session.js";
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from "../../auth/rateLimit.js";
import { SESSION_COOKIE } from "../../hooks.server.js";

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    const data = await request.formData();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    if (!email || !password) {
      return fail(400, { error: "Email and password are required.", email });
    }

    const ip = getClientAddress();

    // Checked before verifyLogin, so a throttled client can't keep making
    // the server compute scrypt hashes either.
    const retryAfter = loginBlockedFor(email, ip);
    if (retryAfter !== null) {
      const minutes = Math.ceil(retryAfter / 60);
      return fail(429, {
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        email,
      });
    }

    const user = verifyLogin(email, password);
    if (!user) {
      recordLoginFailure(email, ip);
      return fail(401, { error: "Incorrect email or password.", email });
    }
    recordLoginSuccess(email);

    const sessionId = createSession(user.id);
    cookies.set(SESSION_COOKIE, sessionId, {
      path: "/",
      httpOnly: true,
      secure: !dev,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // matches SESSION_TTL_MS in auth/session.ts
    });

    throw redirect(302, `${base}/`);
  },
};
