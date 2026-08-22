import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Auth", () => {
  const testDir = mkdtempSync(join(tmpdir(), "claude-coach-auth-test-"));

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
  });

  describe("multi-user migration", () => {
    it("adds user_id to legacy tables and stays idempotent on a second run", async () => {
      const { migrate } = await import("../../src/db/migrate.js");
      const { all } = await import("../../src/db/client.js");

      // beforeAll already ran migrate() once; re-running must not throw
      // "duplicate column" (ALTER TABLE ADD COLUMN isn't idempotent on its own).
      expect(() => migrate()).not.toThrow();

      for (const table of ["activities", "athlete", "goals", "sync_log"]) {
        const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
        expect(columns.map((c) => c.name)).toContain("user_id");
      }
    });
  });

  describe("password hashing", () => {
    it("verifies a correct password and rejects a wrong one", async () => {
      const { hashPassword, verifyPassword } = await import("../../src/auth/password.js");
      const stored = hashPassword("correct horse battery staple");
      expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
      expect(verifyPassword("wrong password", stored)).toBe(false);
    });

    it("produces a different salt (and hash) for the same password each time", async () => {
      const { hashPassword } = await import("../../src/auth/password.js");
      expect(hashPassword("same password")).not.toBe(hashPassword("same password"));
    });

    it("rejects a malformed stored hash instead of throwing", async () => {
      const { verifyPassword } = await import("../../src/auth/password.js");
      expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    });
  });

  describe("users", () => {
    it("creates a user and finds it by email and id", async () => {
      const { createUser, findUserByEmail, findUserById } = await import("../../src/auth/users.js");
      const user = createUser("athlete@example.com", "hunter22222", "Athlete Name");

      expect(user.id).toBeGreaterThan(0);
      expect(findUserByEmail("athlete@example.com")?.id).toBe(user.id);
      expect(findUserById(user.id)?.name).toBe("Athlete Name");
    });

    it("rejects creating a second user with the same email", async () => {
      const { createUser } = await import("../../src/auth/users.js");
      createUser("dup@example.com", "hunter22222");
      expect(() => createUser("dup@example.com", "different-password")).toThrow(/already exists/);
    });

    it("verifies login with correct credentials and rejects wrong password / unknown email", async () => {
      const { createUser, verifyLogin } = await import("../../src/auth/users.js");
      createUser("login@example.com", "correct-password");

      expect(verifyLogin("login@example.com", "correct-password")?.email).toBe("login@example.com");
      expect(verifyLogin("login@example.com", "wrong-password")).toBeNull();
      expect(verifyLogin("nobody@example.com", "correct-password")).toBeNull();
    });
  });

  describe("sessions", () => {
    it("creates a session that validates back to the same user", async () => {
      const { createUser } = await import("../../src/auth/users.js");
      const { createSession, validateSession } = await import("../../src/auth/session.js");

      const user = createUser("session-user@example.com", "hunter22222");
      const sessionId = createSession(user.id);

      expect(sessionId).toHaveLength(64); // 32 random bytes, hex-encoded
      expect(validateSession(sessionId)).toBe(user.id);
    });

    it("rejects an unknown session id", async () => {
      const { validateSession } = await import("../../src/auth/session.js");
      expect(validateSession("not-a-real-session-id")).toBeNull();
    });

    it("revoking a session invalidates it", async () => {
      const { createUser } = await import("../../src/auth/users.js");
      const { createSession, validateSession, revokeSession } =
        await import("../../src/auth/session.js");

      const user = createUser("revoke-user@example.com", "hunter22222");
      const sessionId = createSession(user.id);
      revokeSession(sessionId);

      expect(validateSession(sessionId)).toBeNull();
    });

    it("revoking all sessions for a user invalidates every one of them", async () => {
      const { createUser } = await import("../../src/auth/users.js");
      const { createSession, validateSession, revokeAllSessionsForUser } =
        await import("../../src/auth/session.js");

      const user = createUser("revoke-all-user@example.com", "hunter22222");
      const sessionA = createSession(user.id);
      const sessionB = createSession(user.id);
      revokeAllSessionsForUser(user.id);

      expect(validateSession(sessionA)).toBeNull();
      expect(validateSession(sessionB)).toBeNull();
    });

    it("treats an already-expired session as invalid and cleans it up", async () => {
      const { createUser } = await import("../../src/auth/users.js");
      const { validateSession } = await import("../../src/auth/session.js");
      const { run, get } = await import("../../src/db/client.js");

      const user = createUser("expired-user@example.com", "hunter22222");
      const expiredId = "expired-session-id-for-test";
      run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
        expiredId,
        user.id,
        new Date(Date.now() - 1000).toISOString(),
      ]);

      expect(validateSession(expiredId)).toBeNull();
      expect(get("SELECT id FROM sessions WHERE id = ?", [expiredId])).toBeUndefined();
    });
  });
});
