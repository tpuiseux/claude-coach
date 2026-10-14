import { randomBytes } from "crypto";
import { get, run } from "../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";

export interface User {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: string;
}

/**
 * Creates a user account. There is no public signup - accounts are created
 * by an admin via `npm run create-user` (see scripts/create-user.ts).
 */
export function createUser(email: string, password: string, name?: string): User {
  const existing = findUserByEmail(email);
  if (existing) {
    throw new Error(`A user with email ${email} already exists`);
  }

  const passwordHash = hashPassword(password);
  const result = run("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)", [
    email,
    passwordHash,
    name ?? null,
  ]);

  const user = findUserById(Number(result.lastInsertRowid));
  if (!user) {
    throw new Error("Failed to create user");
  }
  return user;
}

export function findUserByEmail(email: string): User | undefined {
  return get<User>("SELECT * FROM users WHERE email = ?", [email]);
}

export function findUserById(id: number): User | undefined {
  return get<User>("SELECT * FROM users WHERE id = ?", [id]);
}

// Hash of a random password nobody knows, verified against when the email
// is unknown - so that path costs one scrypt too, same as a wrong password.
// Without it, the response time alone reveals which emails have accounts.
let dummyHash: string | null = null;

/**
 * Verifies email+password credentials. Returns the user on success, null on
 * any failure (unknown email or wrong password) - never distinguishes the
 * two to the caller, nor in timing, to avoid leaking which emails have
 * accounts.
 */
export function verifyLogin(email: string, password: string): User | null {
  const user = findUserByEmail(email);
  if (!user) {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    verifyPassword(password, dummyHash);
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}
