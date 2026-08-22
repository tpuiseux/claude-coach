import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Password hashing via Node's built-in scrypt (crypto module) rather than
 * bcrypt/argon2 - this project has no other auth dependencies, and scrypt
 * is an OWASP-acceptable KDF that ships with Node, so it avoids adding one
 * just for this.
 */

const KEY_LENGTH = 64;
const SCHEME = "scrypt";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${SCHEME}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hashHex] = stored.split(":");
  if (scheme !== SCHEME || !salt || !hashHex) return false;

  const candidate = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hashHex, "hex");
  if (candidate.length !== expected.length) return false;

  return timingSafeEqual(candidate, expected);
}
