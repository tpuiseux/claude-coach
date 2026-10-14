/**
 * In-memory failed-login throttle. Single-process only (the app runs as one
 * adapter-node instance) - counters reset on restart, which is acceptable
 * for slowing down online guessing, the only thing this is meant to do.
 *
 * Two independent buckets per attempt:
 * - per email: stops guessing one account's password from many IPs. Low
 *   limit, since a real user rarely mistypes their password 5 times.
 * - per IP: stops one client spraying passwords across many emails. Higher
 *   limit, since several athletes can legitimately share an IP (and behind
 *   nginx every request shares one unless ADDRESS_HEADER is set - see
 *   README).
 */

const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;

interface Bucket {
  failures: number;
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

function keys(email: string, ip: string): { emailKey: string; ipKey: string } {
  return { emailKey: `email:${email.toLowerCase()}`, ipKey: `ip:${ip}` };
}

/** Returns the seconds to wait if either bucket is exhausted, or null if the attempt may proceed. */
export function loginBlockedFor(email: string, ip: string, now = Date.now()): number | null {
  const { emailKey, ipKey } = keys(email, ip);
  const limits: [string, number][] = [
    [emailKey, MAX_FAILURES_PER_EMAIL],
    [ipKey, MAX_FAILURES_PER_IP],
  ];

  let retryAt = 0;
  for (const [key, max] of limits) {
    const bucket = liveBucket(key, now);
    if (bucket && bucket.failures >= max) retryAt = Math.max(retryAt, bucket.resetAt);
  }
  return retryAt ? Math.ceil((retryAt - now) / 1000) : null;
}

export function recordLoginFailure(email: string, ip: string, now = Date.now()): void {
  // Bounded memory: an attacker cycling through emails/IPs only ever grows
  // the map within one window before entries start expiring.
  if (buckets.size > 10_000) sweepExpired(now);

  const { emailKey, ipKey } = keys(email, ip);
  for (const key of [emailKey, ipKey]) {
    const bucket = liveBucket(key, now);
    if (bucket) {
      bucket.failures += 1;
    } else {
      buckets.set(key, { failures: 1, resetAt: now + WINDOW_MS });
    }
  }
}

/** Clears the account's bucket after a successful login. The IP bucket is
 * kept, so one valid account can't be used to reset a spraying IP's count. */
export function recordLoginSuccess(email: string): void {
  buckets.delete(keys(email, "").emailKey);
}

/** Test-only: forget all counters. */
export function resetLoginThrottle(): void {
  buckets.clear();
}
