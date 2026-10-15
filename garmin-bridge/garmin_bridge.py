#!/usr/bin/env python3
"""HTTP bridge between claude-coach and Garmin Connect.

Two independent client modes share this one process:

  1. Legacy (single account, browser-driven): the standalone HTML viewer's
     "Send to Garmin" button (src/viewer/lib/garminBridge.ts) calls
     POST /push-workout directly. It has no notion of a user - the bridge is
     started once, already logged in to whichever account --tokenstore
     points at (see init_api below), and every call pushes to that account.

  2. Multi-tenant (per-account, server-driven): claude-coach's SvelteKit app
     (src/lib/server/garminBridge.ts) calls the /garmin/* routes on behalf
     of whichever athlete is logged in, passing their numeric user id. Each
     user gets their own tokenstore file under --multiuser-tokenstore-dir,
     loaded/refreshed on demand rather than held open for the process
     lifetime - this bridge only ever serves the SvelteKit app, never a
     browser directly, so nginx never routes to /garmin/*.

For testing either mode without a real Garmin login: --dry-run.
"""

import argparse
import hmac
import json
import os
import sys
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from garmin_lib import (
    call_with_retry,
    init_api,
    login_from_tokenstore,
    login_with_credentials,
    resume_mfa,
    save_tokenstore,
)
from sync_activities import find_duplicate_groups, map_activity, pick_primary
from sync_wellness import fetch_body_battery_range, fetch_day
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8420

# How long a login started by /garmin/login may sit waiting for its matching
# /garmin/mfa call before it's dropped. Generous, since a human has to read
# an SMS/app code and type it in, but bounded so an abandoned flow doesn't
# hold a half-authenticated Garmin session in memory forever.
PENDING_LOGIN_TTL_SECONDS = 10 * 60

# Workout payloads are a few KB - anything near this is garbage or abuse,
# and reading it would mean buffering it all in memory first.
MAX_BODY_BYTES = 1024 * 1024

# Per-connection socket timeout, so a client that announces a body and then
# never sends it ties up one worker thread for this long, not forever.
SOCKET_TIMEOUT_SECONDS = 30


# Caps on one sync request. Activities are a single Garmin call however long
# the range; wellness costs ~6 calls per day, so it gets a much shorter leash
# (Garmin rate-limits aggressively, and the request blocks one worker thread
# for its whole duration).
MAX_ACTIVITY_SYNC_DAYS = 120
MAX_WELLNESS_SYNC_DAYS = 31


def parse_date_range(body: dict, max_days: int) -> tuple[date, date] | None:
    """Validated (start, end) from {"start": "YYYY-MM-DD", "end": ...}, or None."""
    try:
        start = date.fromisoformat(str(body.get("start", "")))
        end = date.fromisoformat(str(body.get("end", "")))
    except ValueError:
        return None
    if start > end or (end - start).days + 1 > max_days:
        return None
    return start, end


def activities_for_range(garmin, start: date, end: date) -> tuple[list[dict], int]:
    """Garmin activities in [start, end], mapped to coach.db's activities columns
    (the same mapping sync_activities.py uses) plus `start_date_local`, with
    duplicate recordings of one session dropped. Returns (rows, duplicates removed)."""
    raw = call_with_retry(
        garmin.get_activities_by_date, start.isoformat(), end.isoformat(), sortorder="asc", label="activities"
    )
    rows = []
    for activity in raw:
        row = map_activity(activity)
        # The user's own calendar day: start_date is UTC, so an early-morning
        # run in UTC+2 would otherwise land on the previous day.
        local = activity.get("startTimeLocal")
        row["start_date_local"] = local.replace(" ", "T") if local else None
        rows.append(row)

    by_id = {row["id"]: row for row in rows}
    candidates = [{**row, "raw_json": json.loads(row["raw_json"])} for row in rows]
    dropped = set()
    for group in find_duplicate_groups(candidates):
        primary = pick_primary(group)
        dropped.update(r["id"] for r in group if r["id"] != primary["id"])
    return [by_id[i] for i in by_id if i not in dropped], len(dropped)


def wellness_for_range(garmin, start: date, end: date) -> list[dict]:
    """One daily_wellness row per day in [start, end], as sync_wellness.py builds them."""
    body_battery = fetch_body_battery_range(garmin, start.isoformat(), end.isoformat())
    rows = []
    day = start
    while day <= end:
        rows.append(fetch_day(garmin, day.isoformat(), body_battery))
        day += timedelta(days=1)
    return rows


def is_valid_user_id(value: str) -> bool:
    return value.isdigit() and value != "0"


def log_garmin_error(context: str, user_id: str, err: Exception) -> None:
    """Writes the library's real error to stderr (unbuffered, so it reaches
    journald right away - stdout is block-buffered under systemd).

    The user only ever sees a short French message, and garminconnect files
    many unrelated failures (rate limits, Cloudflare blocks, SSO changes)
    under GarminConnectAuthenticationError - this is the only place the
    actual cause gets recorded.
    """
    chain = []
    cur: BaseException | None = err
    while cur is not None and len(chain) < 4:
        chain.append(f"{type(cur).__name__}: {str(cur)[:300]}")
        cur = cur.__cause__ or cur.__context__
    print(f"[garmin-bridge] {context} user={user_id} failed: " + " <- ".join(chain), file=sys.stderr)


def tokenstore_path_for(user_id: str, multiuser_dir: Path) -> str:
    return str(multiuser_dir / f"{user_id}.json")


def make_handler(api, dry_run, token, allowed_origins, multiuser_dir: Path):
    # userId -> (Garmin instance mid-MFA, started_at). Requests are handled on
    # concurrent threads (ThreadingHTTPServer), so every access goes through
    # pending_lock.
    pending_logins: dict[str, tuple[object, float]] = {}
    pending_lock = threading.Lock()

    # The legacy single-account `api` is one shared Garmin client - not known
    # to be thread-safe, so legacy pushes are serialized. Multi-tenant routes
    # build their own per-request client and don't need this.
    legacy_api_lock = threading.Lock()

    def sweep_pending_logins() -> None:
        cutoff = time.time() - PENDING_LOGIN_TTL_SECONDS
        with pending_lock:
            expired = [uid for uid, (_, started) in pending_logins.items() if started < cutoff]
            for uid in expired:
                del pending_logins[uid]

    def set_pending_login(user_id: str, garmin: object) -> None:
        with pending_lock:
            pending_logins[user_id] = (garmin, time.time())

    def pop_pending_login(user_id: str):
        with pending_lock:
            return pending_logins.pop(user_id, None)

    def is_authorized(headers) -> bool:
        if not token:
            return True
        auth = headers.get("Authorization", "")
        provided = auth[7:] if auth.startswith("Bearer ") else ""
        return hmac.compare_digest(provided, token)

    class Handler(BaseHTTPRequestHandler):
        timeout = SOCKET_TIMEOUT_SECONDS

        def _cors(self) -> None:
            # Reflect back the request's own Origin if it's on the allowlist, rather
            # than always sending one fixed value - a browser only accepts a response
            # whose Access-Control-Allow-Origin exactly matches its own origin, so a
            # single static value breaks the moment the site is reached via a
            # different (but still legitimate) hostname, e.g. bare domain vs "www.".
            # The /garmin/* routes are never called from a browser (only from the
            # SvelteKit server), so this only matters for the legacy routes, but
            # applying it everywhere keeps the handler simple.
            origin = self.headers.get("Origin")
            if origin and origin in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length", 0))
            except ValueError:
                return None
            if length < 0 or length > MAX_BODY_BYTES:
                return None
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return None
            return body if isinstance(body, dict) else None

        def _reject_cross_site(self) -> bool:
            """Blocks requests a web page could forge from a visitor's browser.

            CORS only stops a page from *reading* the response - a cross-site
            POST still reaches the handler and runs. Without a token (the
            default for a local bridge), that would let any site the user
            visits push workouts or disconnect accounts. Two checks close it:
            requiring application/json forces a CORS preflight (which fails
            for disallowed origins, so the real request is never sent), and
            the Origin check catches anything that slips through (including
            DNS-rebinding pages, whose Origin is the attacker's hostname).

            The /garmin/* routes are server-to-server only - Node's fetch sends
            no Origin, so any Origin at all there means a browser.

            Sends the error response and returns True if the request must stop.
            """
            origin = self.headers.get("Origin")
            if origin is not None:
                server_only = self.path.startswith("/garmin/")
                if server_only or origin not in allowed_origins:
                    self._json(403, {"error": "origin not allowed"})
                    return True

            if self.command == "POST":
                content_type = self.headers.get("Content-Type", "")
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    self._json(415, {"error": "Content-Type must be application/json"})
                    return True

            return False

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:
            if self._reject_cross_site():
                return

            if self.path == "/health":
                self._json(200, {"status": "ok", "dryRun": dry_run, "authRequired": bool(token)})
                return

            if self.path.startswith("/garmin/status"):
                self._handle_garmin_status()
                return

            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self._reject_cross_site():
                return

            if self.path == "/push-workout":
                self._handle_legacy_push_workout()
                return
            if self.path == "/garmin/login":
                self._handle_garmin_login()
                return
            if self.path == "/garmin/mfa":
                self._handle_garmin_mfa()
                return
            if self.path == "/garmin/disconnect":
                self._handle_garmin_disconnect()
                return
            if self.path == "/garmin/push-workout":
                self._handle_garmin_push_workout()
                return
            if self.path == "/garmin/activities":
                self._handle_garmin_sync("activities")
                return
            if self.path == "/garmin/wellness":
                self._handle_garmin_sync("wellness")
                return

            self._json(404, {"error": "not found"})

        # -- Legacy, single-account routes -----------------------------------

        def _handle_legacy_push_workout(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            workout_json = body.get("workout")
            if not isinstance(workout_json, dict):
                self._json(400, {"error": "missing 'workout' payload"})
                return

            date = body.get("date")

            if dry_run:
                self._json(
                    200,
                    {
                        "workoutId": "dry-run",
                        "scheduled": bool(date),
                        "date": date,
                        "payload": workout_json,
                    },
                )
                return

            if api is None:
                self._json(
                    503,
                    {"error": "Compte Garmin legacy non connecte - relance le bridge en interactif."},
                )
                return

            try:
                with legacy_api_lock:
                    result = api.upload_workout(workout_json)
                    workout_id = result["workoutId"]
                    if date:
                        api.schedule_workout(workout_id, date)
                self._json(200, {"workoutId": workout_id, "scheduled": bool(date), "date": date})
            except Exception as e:  # surfaced as a message in the button's UI
                self._json(502, {"error": str(e)})

        # -- Multi-tenant routes ----------------------------------------------

        def _handle_garmin_login(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            user_id = str(body.get("userId", ""))
            email = body.get("email")
            password = body.get("password")
            if not is_valid_user_id(user_id) or not email or not password:
                self._json(400, {"error": "userId, email and password are required"})
                return

            sweep_pending_logins()

            if dry_run:
                if password == "mfa":
                    set_pending_login(user_id, "dry-run")
                    self._json(200, {"ok": True, "mfaRequired": True})
                else:
                    Path(tokenstore_path_for(user_id, multiuser_dir)).parent.mkdir(
                        parents=True, exist_ok=True
                    )
                    Path(tokenstore_path_for(user_id, multiuser_dir)).write_text(
                        json.dumps({"dryRun": True})
                    )
                    self._json(200, {"ok": True, "mfaRequired": False})
                return

            try:
                garmin, mfa_status = login_with_credentials(email, password)
            except GarminConnectAuthenticationError as e:
                log_garmin_error("login", user_id, e)
                self._json(401, {"error": "Identifiants Garmin incorrects."})
                return
            except GarminConnectTooManyRequestsError as e:
                log_garmin_error("login", user_id, e)
                self._json(429, {"error": "Trop de tentatives - reessaie plus tard."})
                return
            except GarminConnectConnectionError as e:
                log_garmin_error("login", user_id, e)
                self._json(502, {"error": f"Connexion a Garmin impossible: {e}"})
                return

            if mfa_status:
                set_pending_login(user_id, garmin)
                self._json(200, {"ok": True, "mfaRequired": True})
                return

            save_tokenstore(garmin, tokenstore_path_for(user_id, multiuser_dir))
            self._json(200, {"ok": True, "mfaRequired": False})

        def _handle_garmin_mfa(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            user_id = str(body.get("userId", ""))
            code = body.get("code")
            if not is_valid_user_id(user_id) or not code:
                self._json(400, {"error": "userId and code are required"})
                return

            sweep_pending_logins()

            pending = pop_pending_login(user_id)
            if pending is None:
                self._json(400, {"error": "Pas de connexion en attente - recommence."})
                return

            if dry_run:
                Path(tokenstore_path_for(user_id, multiuser_dir)).parent.mkdir(
                    parents=True, exist_ok=True
                )
                Path(tokenstore_path_for(user_id, multiuser_dir)).write_text(
                    json.dumps({"dryRun": True})
                )
                self._json(200, {"ok": True})
                return

            garmin, _ = pending
            try:
                resume_mfa(garmin, code)
            except GarminConnectAuthenticationError as e:
                log_garmin_error("mfa", user_id, e)
                self._json(401, {"error": "Code incorrect - recommence la connexion."})
                return
            except GarminConnectTooManyRequestsError as e:
                log_garmin_error("mfa", user_id, e)
                self._json(429, {"error": "Trop de tentatives - reessaie plus tard."})
                return
            except GarminConnectConnectionError as e:
                log_garmin_error("mfa", user_id, e)
                self._json(502, {"error": f"Connexion a Garmin impossible: {e}"})
                return

            save_tokenstore(garmin, tokenstore_path_for(user_id, multiuser_dir))
            self._json(200, {"ok": True})

        def _handle_garmin_status(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
            user_id = params.get("userId", "")
            if not is_valid_user_id(user_id):
                self._json(400, {"error": "userId is required"})
                return

            connected = Path(tokenstore_path_for(user_id, multiuser_dir)).exists()
            self._json(200, {"connected": connected})

        def _handle_garmin_disconnect(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            user_id = str(body.get("userId", ""))
            if not is_valid_user_id(user_id):
                self._json(400, {"error": "userId is required"})
                return

            pop_pending_login(user_id)
            Path(tokenstore_path_for(user_id, multiuser_dir)).unlink(missing_ok=True)
            self._json(200, {"ok": True})

        def _handle_garmin_push_workout(self) -> None:
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            user_id = str(body.get("userId", ""))
            workout_json = body.get("workout")
            date = body.get("date")
            if not is_valid_user_id(user_id) or not isinstance(workout_json, dict):
                self._json(400, {"error": "userId and workout are required"})
                return

            if dry_run:
                self._json(
                    200,
                    {
                        "workoutId": "dry-run",
                        "scheduled": bool(date),
                        "date": date,
                        "payload": workout_json,
                    },
                )
                return

            tokenstore = tokenstore_path_for(user_id, multiuser_dir)
            if not Path(tokenstore).exists():
                self._json(409, {"error": "Compte Garmin non connecte pour cet utilisateur."})
                return

            try:
                garmin = login_from_tokenstore(tokenstore)
            except (GarminConnectAuthenticationError, GarminConnectConnectionError):
                self._json(
                    409,
                    {"error": "Session Garmin expiree - reconnecte le compte dans les Settings."},
                )
                return

            try:
                result = garmin.upload_workout(workout_json)
                workout_id = result["workoutId"]
                if date:
                    garmin.schedule_workout(workout_id, date)
                self._json(200, {"workoutId": workout_id, "scheduled": bool(date), "date": date})
            except Exception as e:
                self._json(502, {"error": str(e)})

        def _user_session(self, user_id: str):
            """The user's Garmin session, or None after sending the error response."""
            tokenstore = tokenstore_path_for(user_id, multiuser_dir)
            if not Path(tokenstore).exists():
                self._json(409, {"error": "Compte Garmin non connecte pour cet utilisateur."})
                return None
            try:
                return login_from_tokenstore(tokenstore)
            except (GarminConnectAuthenticationError, GarminConnectConnectionError) as e:
                log_garmin_error("session", user_id, e)
                self._json(
                    409,
                    {"error": "Session Garmin expiree - reconnecte le compte dans les Settings."},
                )
                return None

        def _handle_garmin_sync(self, kind: str) -> None:
            """POST /garmin/activities | /garmin/wellness {userId, start, end}.

            Read-only towards Garmin, and stateless here: the rows go back to
            the web app, which owns the database they're stored in.
            """
            if not is_authorized(self.headers):
                self._json(401, {"error": "unauthorized"})
                return

            body = self._read_json_body()
            if body is None:
                self._json(400, {"error": "invalid JSON body"})
                return

            user_id = str(body.get("userId", ""))
            max_days = MAX_ACTIVITY_SYNC_DAYS if kind == "activities" else MAX_WELLNESS_SYNC_DAYS
            date_range = parse_date_range(body, max_days)
            if not is_valid_user_id(user_id) or date_range is None:
                self._json(
                    400,
                    {"error": f"userId and a start/end range of at most {max_days} days are required"},
                )
                return
            start, end = date_range

            if dry_run:
                self._json(200, {"activities": [], "duplicatesRemoved": 0} if kind == "activities" else {"days": []})
                return

            garmin = self._user_session(user_id)
            if garmin is None:
                return

            try:
                if kind == "activities":
                    rows, removed = activities_for_range(garmin, start, end)
                    self._json(200, {"activities": rows, "duplicatesRemoved": removed})
                else:
                    self._json(200, {"days": wellness_for_range(garmin, start, end)})
            except GarminConnectTooManyRequestsError as e:
                log_garmin_error(kind, user_id, e)
                self._json(429, {"error": "Garmin limite les requetes - reessaie plus tard."})
            except Exception as e:
                log_garmin_error(kind, user_id, e)
                self._json(502, {"error": f"Synchronisation Garmin impossible: {e}"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - matches base signature
            print("[garmin-bridge]", format % args)

    return Handler


def load_legacy_api(tokenstore: str):
    """The legacy single-account session, or None if it can't be had.

    Under systemd there's no terminal, so init_api's interactive login
    fallback would crash on input() - and take the multi-tenant /garmin/*
    routes down with it, though they never use this account. So: prompt
    only when a human is attached; otherwise start without the legacy
    account and let /push-workout answer 503 until it's reconnected.
    """
    if sys.stdin.isatty():
        return init_api(tokenstore)
    try:
        return login_from_tokenstore(tokenstore)
    except Exception as e:  # any failure here must not stop the multi-tenant routes
        print(
            f"Compte legacy indisponible ({tokenstore}): {e}\n"
            "/push-workout desactive ; les routes /garmin/* restent actives. "
            "Pour le reconnecter : lance le bridge une fois en interactif.",
            file=sys.stderr,
        )
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Bind address (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--allowed-origin",
        default=os.getenv("GARMIN_BRIDGE_ALLOWED_ORIGIN", ""),
        help="Comma-separated origins allowed to call this bridge from a browser "
        "(e.g. https://your-site.example,https://www.your-site.example — include "
        "every hostname variant the page might actually be loaded from). Not a real "
        "security boundary on its own (only browsers honor CORS) — the bearer token "
        "is what actually protects the endpoint. Irrelevant to the /garmin/* routes, "
        "which are only ever called server-to-server.",
    )
    parser.add_argument(
        "--tokenstore",
        default=os.getenv("GARMINTOKENS", str(Path("~/.garminconnect").expanduser())),
        help="Legacy single-account tokenstore, loaded once at startup for /push-workout.",
    )
    parser.add_argument(
        "--multiuser-tokenstore-dir",
        default=os.getenv(
            "GARMIN_MULTIUSER_TOKENSTORE_DIR", str(Path("~/.garmin-tokens-multiuser").expanduser())
        ),
        help="Directory holding one tokenstore file per user id, for the /garmin/* routes.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Ne se connecte pas a Garmin ; renvoie le payload recu tel quel (pour tester le bouton sans compte reel)",
    )
    args = parser.parse_args()

    # $GARMINTOKENS only ever means the legacy account's tokenstore, and it's
    # now captured in args.tokenstore. Drop it from the environment so
    # garminconnect can't fall back to it on its own - a multi-tenant login
    # (login_with_credentials) would otherwise load the legacy account's
    # session instead of the credentials the user just typed.
    os.environ.pop("GARMINTOKENS", None)

    token = os.getenv("GARMIN_BRIDGE_TOKEN", "")
    if args.host != "127.0.0.1" and not token:
        print(
            f"Refuse de demarrer sur --host {args.host} sans GARMIN_BRIDGE_TOKEN defini.\n"
            "Binder sur une adresse joignable sans jeton d'auth exposerait ton compte Garmin "
            "a quiconque trouve l'URL. Definis GARMIN_BRIDGE_TOKEN ou reviens a 127.0.0.1.",
            file=sys.stderr,
        )
        sys.exit(1)

    api = None if args.dry_run else load_legacy_api(args.tokenstore)

    multiuser_dir = Path(args.multiuser_tokenstore_dir).expanduser()
    multiuser_dir.mkdir(parents=True, exist_ok=True)

    allowed_origins = {o.strip() for o in args.allowed_origin.split(",") if o.strip()}
    handler = make_handler(api, args.dry_run, token, allowed_origins, multiuser_dir)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    mode = "DRY-RUN (aucun envoi reel a Garmin)" if args.dry_run else "connecte a Garmin"
    auth_state = "jeton requis" if token else "AUCUNE AUTH (local uniquement)"
    print(f"Garmin bridge en ecoute sur http://{args.host}:{args.port} [{mode}, {auth_state}]")
    print(f"Tokenstores multi-comptes: {multiuser_dir}")
    print("Laisse ce process actif, puis clique sur le bouton Garmin dans le plan HTML (n'importe quelle seance).")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArret du bridge.")


if __name__ == "__main__":
    main()
