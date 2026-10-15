import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_FAILURES_PER_EMAIL,
  MAX_FAILURES_PER_IP,
  MAX_SIGNUP_ATTEMPTS_PER_IP,
  loginBlockedFor,
  recordSignupAttempt,
  signupBlockedFor,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
} from "../../src/auth/rateLimit.js";

describe("login throttle", () => {
  beforeEach(() => resetLoginThrottle());

  it("blocks an email after too many failures, from any IP", () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      expect(loginBlockedFor("a@x.fr", `10.0.0.${i}`)).toBeNull();
      recordLoginFailure("a@x.fr", `10.0.0.${i}`);
    }
    expect(loginBlockedFor("a@x.fr", "10.9.9.9")).toBeGreaterThan(0);
    // case-insensitive, so "A@X.FR" isn't a free extra bucket
    expect(loginBlockedFor("A@X.FR", "10.9.9.9")).toBeGreaterThan(0);
    // other accounts are unaffected
    expect(loginBlockedFor("b@x.fr", "10.9.9.9")).toBeNull();
  });

  it("blocks an IP spraying many emails", () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      recordLoginFailure(`user${i}@x.fr`, "1.2.3.4");
    }
    expect(loginBlockedFor("fresh@x.fr", "1.2.3.4")).toBeGreaterThan(0);
    expect(loginBlockedFor("fresh@x.fr", "5.6.7.8")).toBeNull();
  });

  it("expires after the window", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) recordLoginFailure("a@x.fr", "1.1.1.1", now);
    expect(loginBlockedFor("a@x.fr", "1.1.1.1", now)).toBeGreaterThan(0);
    expect(loginBlockedFor("a@x.fr", "1.1.1.1", now + 15 * 60 * 1000 + 1)).toBeNull();
  });

  it("caps signup attempts per IP, independently of login", () => {
    for (let i = 0; i < MAX_SIGNUP_ATTEMPTS_PER_IP; i++) {
      expect(signupBlockedFor("9.9.9.9")).toBeNull();
      recordSignupAttempt("9.9.9.9");
    }
    expect(signupBlockedFor("9.9.9.9")).toBeGreaterThan(0);
    expect(signupBlockedFor("8.8.8.8")).toBeNull();
    expect(loginBlockedFor("a@x.fr", "9.9.9.9")).toBeNull();
  });

  it("a successful login resets the account's count, not the IP's", () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL - 1; i++) recordLoginFailure("a@x.fr", "1.1.1.1");
    recordLoginSuccess("a@x.fr");
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL - 1; i++) recordLoginFailure("a@x.fr", "1.1.1.1");
    expect(loginBlockedFor("a@x.fr", "1.1.1.1")).toBeNull();
  });
});
