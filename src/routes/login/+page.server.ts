import { fail, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { Actions, PageServerLoad } from "./$types";
import { verifyLogin } from "../../auth/users.js";
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from "../../auth/rateLimit.js";
import { isSignupOpen } from "../../auth/signup.js";
import { startSession } from "$lib/server/sessionCookie.js";

export const load: PageServerLoad = async () => {
  return { signupOpen: isSignupOpen() };
};

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

    startSession(cookies, user.id);
    throw redirect(302, `${base}/`);
  },
};
