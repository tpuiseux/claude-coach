import { error, fail, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { Actions, PageServerLoad } from "./$types";
import { isSignupOpen, registerUser, SignupError, MIN_PASSWORD_LENGTH } from "../../auth/signup.js";
import { recordSignupAttempt, signupBlockedFor } from "../../auth/rateLimit.js";
import { startSession } from "$lib/server/sessionCookie.js";

export const load: PageServerLoad = async () => {
  // Closed signup looks like no signup at all, rather than advertising a
  // form nobody can use.
  if (!isSignupOpen()) throw error(404, "Not found");
  return { minPasswordLength: MIN_PASSWORD_LENGTH };
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    const data = await request.formData();
    const field = (name: string) => String(data.get(name) ?? "");
    const email = field("email");
    const name = field("name");

    const ip = getClientAddress();
    const retryAfter = signupBlockedFor(ip);
    if (retryAfter !== null) {
      const minutes = Math.ceil(retryAfter / 60);
      return fail(429, {
        error: `Too many attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        email,
        name,
      });
    }
    // Every attempt counts, successful or not: this bounds both guessing
    // the invite code and creating accounts in bulk from one address.
    recordSignupAttempt(ip);

    let userId: number;
    try {
      userId = registerUser({
        email,
        name,
        password: field("password"),
        confirmPassword: field("confirmPassword"),
        inviteCode: field("inviteCode"),
      }).id;
    } catch (err) {
      if (err instanceof SignupError) return fail(400, { error: err.message, email, name });
      throw err;
    }

    startSession(cookies, userId);
    throw redirect(302, `${base}/`);
  },
};
