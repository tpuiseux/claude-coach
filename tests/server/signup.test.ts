import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SignupInput } from "../../src/auth/signup.js";

const CODE = "spring-2027";

const input = (overrides: Partial<SignupInput> = {}): SignupInput => ({
  email: "new.athlete@example.com",
  name: "New Athlete",
  password: "long-enough-pw",
  confirmPassword: "long-enough-pw",
  inviteCode: CODE,
  ...overrides,
});

describe("signup", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-signup-test-"));

  beforeAll(async () => {
    process.env.CLAUDE_COACH_DB_PATH = join(testDir, "test.db");
    const { initDatabase } = await import("../../src/db/client.js");
    const { migrate } = await import("../../src/db/migrate.js");
    await initDatabase();
    migrate();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_COACH_DB_PATH;
    delete process.env.SIGNUP_INVITE_CODE;
  });

  beforeEach(() => {
    delete process.env.SIGNUP_INVITE_CODE;
  });

  it("is closed unless SIGNUP_INVITE_CODE is set", async () => {
    const { isSignupOpen, registerUser } = await import("../../src/auth/signup.js");
    expect(isSignupOpen()).toBe(false);
    expect(() => registerUser(input({ email: "closed@example.com" }))).toThrow(/closed/);

    process.env.SIGNUP_INVITE_CODE = "   ";
    expect(isSignupOpen()).toBe(false); // whitespace-only doesn't open it

    process.env.SIGNUP_INVITE_CODE = CODE;
    expect(isSignupOpen()).toBe(true);
  });

  it("creates an account that can then log in", async () => {
    const { registerUser } = await import("../../src/auth/signup.js");
    const { verifyLogin } = await import("../../src/auth/users.js");

    const user = registerUser(input({ email: "  works@example.com " }), CODE);
    expect(user.email).toBe("works@example.com");
    expect(user.name).toBe("New Athlete");
    expect(verifyLogin("works@example.com", "long-enough-pw")?.id).toBe(user.id);
  });

  it("checks the invite code first, revealing nothing else without it", async () => {
    const { registerUser, SignupError } = await import("../../src/auth/signup.js");
    registerUser(input({ email: "taken@example.com" }), CODE);

    // Wrong code + an existing email + a bad password: only the code is reported.
    expect(() =>
      registerUser(input({ email: "taken@example.com", password: "x", inviteCode: "nope" }), CODE)
    ).toThrow(/invite code/);
    expect(() => registerUser(input({ inviteCode: "" }), CODE)).toThrow(SignupError);
    // surrounding whitespace from copy-paste is fine
    expect(() =>
      registerUser(input({ email: "paste@example.com", inviteCode: ` ${CODE}\n` }), CODE)
    ).not.toThrow();
  });

  it("rejects bad input with a user-facing message", async () => {
    const { registerUser } = await import("../../src/auth/signup.js");
    expect(() => registerUser(input({ email: "not-an-email" }), CODE)).toThrow(/valid email/);
    expect(() =>
      registerUser(input({ password: "short", confirmPassword: "short" }), CODE)
    ).toThrow(/at least 8/);
    const huge = "x".repeat(300);
    expect(() => registerUser(input({ password: huge, confirmPassword: huge }), CODE)).toThrow(
      /at most/
    );
    expect(() => registerUser(input({ confirmPassword: "different-pw" }), CODE)).toThrow(
      /don't match/
    );
    expect(() => registerUser(input({ name: "n".repeat(101) }), CODE)).toThrow(/Name/);
  });

  it("treats emails case-insensitively, for duplicates and for login", async () => {
    const { registerUser } = await import("../../src/auth/signup.js");
    const { verifyLogin } = await import("../../src/auth/users.js");

    registerUser(input({ email: "Marie@Example.com" }), CODE);
    expect(() => registerUser(input({ email: "marie@example.com" }), CODE)).toThrow(
      /already exists/
    );
    expect(verifyLogin("MARIE@example.COM", "long-enough-pw")).not.toBeNull();
  });

  it("stores an empty name as null", async () => {
    const { registerUser } = await import("../../src/auth/signup.js");
    expect(registerUser(input({ email: "noname@example.com", name: "   " }), CODE).name).toBeNull();
  });
});
