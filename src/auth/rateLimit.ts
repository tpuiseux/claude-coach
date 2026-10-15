/**
 * In-memory attempt throttles for the public auth forms. Single-process
 * only (the app runs as one adapter-node instance) - counters reset on
 * restart, which is acceptable for slowing down online guessing, the only
 * thing this is meant to do.
 *
 * Login uses two independent buckets per attempt:
 * - per email: stops guessing one account's password from many IPs. Low
 *   limit, since a real user rarely mistypes their password 5 times.
 * - per IP: stops one client spraying passwords across many emails. Higher
 *   limit, since several athletes can legitimately share an IP (and behind
 *   a proxy every request shares one unless ADDRESS_HEADER is set - see
 *   README).
 *
 * Signup uses one per-IP bucket counting every attempt, successful or not:
 * it bounds both guessing the invite code and mass account creation.
 */

const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;
export const MAX_SIGNUP_ATTEMPTS_PER_IP = 10;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function liveBucket(key: string, now: number): Bucket | undefined {
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt <= now) {
    buckets.delete(key);
    return undefined;
  }
  return bucket;
}

function increment(key: string, now: number): void {
  // Bounded memory: an attacker cycling through emails/IPs only ever grows
  // the map within one window before entries start expiring.
  if (buckets.size > 10_000) sweepExpired(now);

  const bucket = liveBucket(key, now);
  if (bucket) {
    bucket.count += 1;
  } else {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  }
}

/** Seconds until every exhausted bucket among `limits` has reset, or null if none is exhausted. */
function blockedFor(limits: [key: string, max: number][], now: number): number | null {
  let retryAt = 0;
  for (const [key, max] of limits) {
    const bucket = liveBucket(key, now);
    if (bucket && bucket.count >= max) retryAt = Math.max(retryAt, bucket.resetAt);
  }
  return retryAt ? Math.ceil((retryAt - now) / 1000) : null;
}

const emailKey = (email: string) => `login-email:${email.toLowerCase()}`;
const loginIpKey = (ip: string) => `login-ip:${ip}`;
const signupIpKey = (ip: string) => `signup-ip:${ip}`;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** Returns the seconds to wait if either bucket is exhausted, or null if the attempt may proceed. */
export function loginBlockedFor(email: string, ip: string, now = Date.now()): number | null {
  return blockedFor(
    [
      [emailKey(email), MAX_FAILURES_PER_EMAIL],
      [loginIpKey(ip), MAX_FAILURES_PER_IP],
    ],
    now
  );
}

export function recordLoginFailure(email: string, ip: string, now = Date.now()): void {
  increment(emailKey(email), now);
  increment(loginIpKey(ip), now);
}

/** Clears the account's bucket after a successful login. The IP bucket is
 * kept, so one valid account can't be used to reset a spraying IP's count. */
export function recordLoginSuccess(email: string): void {
  buckets.delete(emailKey(email));
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export function signupBlockedFor(ip: string, now = Date.now()): number | null {
  return blockedFor([[signupIpKey(ip), MAX_SIGNUP_ATTEMPTS_PER_IP]], now);
}

export function recordSignupAttempt(ip: string, now = Date.now()): void {
  increment(signupIpKey(ip), now);
}

/** Test-only: forget all counters. */
export function resetLoginThrottle(): void {
  buckets.clear();
}
