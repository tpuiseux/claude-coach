import type { Handle } from "@sveltejs/kit";
import { base } from "$app/paths";
import { initDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { validateSession } from "./auth/session.js";
import { findUserById } from "./auth/users.js";

export const SESSION_COOKIE = "session";

// initDatabase()/migrate() are cheap once run, but async - cache the
// promise so every request after the first just awaits the same one
// instead of re-running the (idempotent, but pointless) migration.
let dbReady: Promise<void> | null = null;
function ensureDb(): Promise<void> {
  if (!dbReady) {
    dbReady = initDatabase().then(() => migrate());
  }
  return dbReady;
}

// Public routes: everything else requires a session, enforced here rather
// than per-route so a new route can't accidentally ship unauthenticated.
// event.url.pathname includes `base` (nginx passes the full path through
// unchanged, matching how paths.base is configured - see svelte.config.js),
// so comparisons/redirects here need `base` prepended too.
const PUBLIC_ROUTES = new Set([`${base}/login`]);

export const handle: Handle = async ({ event, resolve }) => {
  await ensureDb();

  const sessionId = event.cookies.get(SESSION_COOKIE);
  const userId = sessionId ? validateSession(sessionId) : null;

  if (userId) {
    const user = findUserById(userId);
    event.locals.user = user ? { id: user.id, email: user.email, name: user.name } : null;
  } else {
    event.locals.user = null;
  }

  const isPublicRoute = PUBLIC_ROUTES.has(event.url.pathname);

  if (!event.locals.user && !isPublicRoute) {
    return new Response(null, { status: 302, headers: { location: `${base}/login` } });
  }
  if (event.locals.user && isPublicRoute) {
    return new Response(null, { status: 302, headers: { location: `${base}/` } });
  }

  return resolve(event);
};
