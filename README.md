# Claude Coach

Claude Coach allows you to use Claude to create custom-tailored training programs for triathlons, marathons, and other endurance activities. Using a data-driven approach and principles from top training plans, Claude will create a training plan that's uniquely fit for you, your personal fitness, and the constraints you have in the next couple of weeks. Maybe you're recovering from an injury, maybe you're traveling and don't have access to a pool or track in a certain week - tell Claude about it and it'll create a plan that works for you.

By default, the output is a self-contained HTML file - a training plan app that allows you to add, edit, or move workouts, mark them as complete, and update key training data like heart rate zones, LTHR, threshold paces, FTP, and others. Your data is kept locally in your browser. If you'd rather have your plan(s) live on a server you control instead - with real accounts and no browser storage involved - see [Self-Hosting the Web App](#self-hosting-the-web-app-optional) below.

Workouts can be exported as simple calendar events (.ics), Zwift (.zwo), Garmin (.fit), or TrainerRoad/ERG (.mrc) workouts.

## Examples

See example training plans at [felixrieseberg.github.io/claude-coach](https://felixrieseberg.github.io/claude-coach/#demos) (demo gallery from the upstream project this fork is based on).

## Installation & Creating a training plan

To use this tool, you need access to Claude.ai or Claude Code with network access for Skills. Depending on user/admin settings, Skills may have full, partial, or no network access.

Syncing your Garmin activity history and creating a tailored training plan takes ca. 15 minutes. Garmin sync needs Python 3 installed locally (a one-time `pip install`, see Option 1 below) - everything else only needs Node.js, via `npx`.

### Installing the Skill

First, [download the latest skill from GitHub Releases](https://github.com/tpuiseux/claude-coach/releases/latest/download/coach-skill.zip).

**Claude.ai:**

1. Open [Claude.ai Settings](https://claude.ai/settings/capabilities)
2. Enable "Code execution and file creation"
3. In the allowed domains list, add `*.strava.com`
4. Scroll down to "Skills" and click "Add skill", then upload the `coach-skill.zip` file

**Claude Code:**

1. Run `/install-skill` and provide the path to the `coach-skill.zip` file you downloaded.

### Creating a plan

Use the most capable model available to you (as I'm writing this, that's Opus 4.5). Prompt Claude with something like this:

> Help me create a training plan for the Ironman 70.3 Oceanside on March 29th 2026 using the "coach" skill.

Claude will ask how you'd like to provide your fitness data. You have two options: You can either tell Claude about your fitness history manually - or you can give it access to your Garmin Connect activity history. I recommend the later - data doesn't lie and more data allows Claude to make a training plan that really fits you.

#### Option 1: Connect to Garmin Connect (Recommended)

The easiest way to get a personalized plan is to let Claude analyze your Garmin training history. This gives Claude real data about your current fitness, training patterns, and progress.

The first time, Claude needs a small local Python environment to talk to Garmin Connect on your behalf (Garmin has no public API, so this uses the same login flow the [Garmin Connect app](https://connect.garmin.com/) itself uses, MFA included):

```bash
cd garmin-bridge && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
```

From then on, Claude runs `garmin-bridge/sync_activities.py` itself - you'll be prompted for your Garmin email, password, and MFA code (if enabled) once; a session token gets cached locally so you won't be asked again on later syncs. Your password is never stored.

If you'd rather use Strava instead (still supported, just no longer the default the skill offers), ask Claude to use `npx claude-coach auth`/`sync` and it'll walk you through registering a Strava API app at [strava.com/settings/api](https://www.strava.com/settings/api).

#### Option 2: Manual Entry

Don't want to connect Garmin (or Strava)? No problem. You can tell Claude about your fitness directly. Be prepared to share:

**Current Training (recent 4-8 weeks):**

- Weekly training hours by sport (swim/bike/run)
- Typical long session distances (longest ride, longest run, etc.)
- Training consistency (how many weeks have you been training regularly?)

**Performance Benchmarks (any you know):**

- Bike FTP (Functional Threshold Power) in watts
- Run threshold pace or recent race times (5K, 10K, half marathon, etc.)
- Swim CSS (Critical Swim Speed) or recent time trial (e.g., 1000m time)
- Max heart rate and/or lactate threshold heart rate

### Telling Claude about your event & constraints

In the next step, Claude will ask you about yourself, the event you're training for, and any constraints it should keep in mind. Examples of information you'd tell any coach:

- Years in the sport
- Previous races completed (distances and approximate times)
- Any recent breaks from training
- Injuries or health issues
- Schedule limitations (work travel, family, etc.)
- Equipment access (pool availability, trainer, etc.)

Claude will use this information to create a plan tailored to your current fitness level. The more detail you provide, the better your plan will be.

## Self-Hosting the Web App (Optional)

Instead of a static HTML file, you can run Claude Coach as a small multi-user web app: real accounts (email + password), plans stored in a server-side SQLite database, and a UI to import/edit them - useful if you're coaching a few people, or just want your own plan to survive clearing your browser. Athletes sign up with an invite code you hand out (or you create their accounts yourself), and the app works on phones, where it can be installed on the home screen.

This is optional and separate from the default skill workflow above - most people don't need it.

**Requirements:** Docker (recommended), or Node.js 22.5+ directly (needed for the built-in `node:sqlite` module the app uses).

### 1. Build and run

```bash
git clone https://github.com/tpuiseux/claude-coach.git
cd claude-coach
docker build --build-arg BASE_PATH= -t claude-coach-web .
```

`BASE_PATH` is baked in at build time - leave it empty to serve from the domain root, or set it (e.g. `/training-plan`) if you're putting the app behind a reverse proxy on a subpath.

Run it with a persistent volume for the database:

```yaml
# compose.yml
services:
  claude-coach-web:
    image: claude-coach-web
    ports:
      - "3000:3000"
    environment:
      - CLAUDE_COACH_DB_PATH=/data/coach.db
      - ORIGIN=https://your-domain.example
      - PORT=3000
      # Behind a reverse proxy, tell the app which header carries the real
      # client IP - otherwise every request looks like it comes from the
      # proxy, and the per-IP limits on login (20 failures / 15 min) and
      # sign-up (10 attempts / 15 min) apply to all users at once. Use the
      # header your proxy actually sets, and only that one (a client could
      # forge any other):
      #   nginx `proxy_set_header X-Real-IP $remote_addr;`
      #     -> ADDRESS_HEADER=X-Real-IP
      #   nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
      #     -> ADDRESS_HEADER=X-Forwarded-For and XFF_DEPTH=1
      # - ADDRESS_HEADER=X-Real-IP
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

### 2. Create an account

Athletes can create their own account at `/signup`, gated by an invite code you hand out. Set it in the web app's environment (e.g. its `.env`) and restart the container:

```
SIGNUP_INVITE_CODE=<a code you choose>
```

With `SIGNUP_INVITE_CODE` unset, sign-ups are closed: `/signup` returns 404 and the login page shows no sign-up link. Change the code at any time to stop new sign-ups with the old one (existing accounts are unaffected). Attempts are capped at 10 per IP per 15 minutes.

You can also create accounts yourself, with sign-ups open or not. The admin scripts need `devDependencies` (they're not in the production image), so run them from a local clone instead - pointed at the same database file your container's volume uses:

```bash
npm install
CLAUDE_COACH_DB_PATH=./data/coach.db npm run create-user -- --email you@example.com --name "Your Name"
```

It'll prompt for a password (or pass `--password` to script it non-interactively). Repeat for each athlete you're setting up.

### 3. Import a plan

Generate a plan as usual with the `coach` skill, then log in to the web app and use the "Import plan" button on the dashboard to upload the resulting JSON file. Re-importing the same file later (e.g. after a plan revision) updates it in place.

If you already have a `~/.claude-coach/coach.db` from using the CLI/skill directly on this machine, `npm run migrate-to-multiuser -- --email you@example.com --plan /path/to/plan.json` attaches that existing data (synced activities, etc.) to a freshly created account in one step, instead of starting from an empty database.

### 4. Garmin Connect integration (optional)

Workouts can be pushed straight to a connected Garmin Connect account from the web app (Settings → Garmin, then a "Send to Garmin" button on each workout). This needs a small Python bridge running alongside the web app - the app never talks to Garmin directly, and the bridge should **never** be exposed publicly.

```bash
cd garmin-bridge
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
GARMIN_BRIDGE_TOKEN=<a random secret> ./venv/bin/python3 garmin_bridge.py --host 127.0.0.1 --port 8420
```

Then point the web app at it (add to its environment):

```
GARMIN_BRIDGE_URL=http://127.0.0.1:8420
GARMIN_BRIDGE_TOKEN=<the same random secret>
```

If the web app runs in Docker and the bridge runs directly on the host (as above), `127.0.0.1` inside the container won't reach it - use the host's address on the Docker bridge network instead (`http://172.17.0.1:8420` on Linux, or `http://host.docker.internal:8420` on Docker Desktop for Mac/Windows). Binding the bridge to anything other than `127.0.0.1` requires `GARMIN_BRIDGE_TOKEN`; it refuses to start without one.

Each connected athlete gets their own Garmin session token, stored server-side under `~/.garmin-tokens-multiuser/<user id>.json` by default (configurable via `--multiuser-tokenstore-dir`) - never their password, which is only used once, in-memory, to establish that session. The session refreshes itself and is saved back on each refresh, so athletes normally connect once.

Under systemd (or anything else without a terminal), run the bridge with its output unbuffered or check `journalctl -u <service>`: when a connection fails, the athlete only sees a short message, and the actual Garmin error is written to the bridge's stderr.

#### When Garmin blocks logins from your server

Garmin's sign-in (behind Cloudflare) often rejects password logins from datacenter IPs - the bridge's log then shows `HTTP 403` / `429` errors ending in `All login strategies exhausted`, and the athlete sees "Connexion a Garmin impossible". Token refreshes from the same server keep working, so the workaround is to log in once from a residential connection and copy the session over:

1. On your own computer (from a clone of this repo, with the bridge's venv installed as above), the athlete logs in - it prompts for their email, password and MFA code, and only talks to Garmin:

   ```bash
   cd garmin-bridge
   ./venv/bin/python3 login_local.py --out ~/garmin-token.json
   ```

2. Copy the file to the server as that athlete's tokenstore, then delete the local copy:

   ```bash
   scp ~/garmin-token.json your-server:.garmin-tokens-multiuser/<user id>.json
   ssh your-server chmod 600 .garmin-tokens-multiuser/<user id>.json
   rm ~/garmin-token.json
   ```

3. Mark the account as connected in the web app's database (this is the row the "Connect" button writes on success):

   ```bash
   docker exec <web container> node -e "new (require('node:sqlite').DatabaseSync)('/data/coach.db').prepare(\"INSERT INTO garmin_credentials (user_id, tokenstore_path) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET connected_at = datetime('now')\").run(<user id>, 'multiuser:<user id>')"
   ```

The athlete's Garmin settings then show the account as connected, and "Send to Garmin" works as usual.

#### The standalone HTML viewer's "Send to Garmin" button

The static HTML plan (not the web app) can push workouts through the same bridge, from the browser, using a single Garmin account: the one whose session is saved at `--tokenstore` (default `$GARMINTOKENS`, else `~/.garminconnect`). Run the bridge once in a terminal to log that account in; if the session later expires, the bridge still starts (under systemd it can't prompt) and only that button stops working until you log in again the same way.

Because this button calls the bridge from a browser, the bridge must be reachable from it, and the page's origin must be allowed: `--allowed-origin https://your-site.example,https://www.your-site.example` (or `GARMIN_BRIDGE_ALLOWED_ORIGIN`). Requests from any other origin are rejected. If you expose the bridge through a reverse proxy for this, expose only what the button needs and block the multi-tenant routes, which act on any user id:

```nginx
location /your-path/garmin-bridge/garmin/ { return 404; }
location /your-path/garmin-bridge/ { proxy_pass http://127.0.0.1:8420/; }
```

### 5. Use it on a phone

The web app adapts to small screens: the plan opens on today, one row per day, with plan details and filters behind the ☰ menu. To install it like an app on an iPhone, open it in **Safari**, then Share → **Add to Home Screen** (Android/Chrome: menu → **Install app**). It then opens full-screen with its own icon. Log in once inside the installed app - iOS keeps its storage separate from Safari's. An internet connection is needed (there's no offline mode).

# About

This is [tpuiseux/claude-coach](https://github.com/tpuiseux/claude-coach), a fork of [felixrieseberg/claude-coach](https://github.com/felixrieseberg/claude-coach) extended with Garmin Connect integration (activity + wellness sync, pushing workouts back to a watch), the companion `weekly-review` skill, road-race periodization for 5K/10K/half/marathon events, and the self-hosted multi-user web app described above.

Claude Coach is an independent, open-source project and is not made by, endorsed by, or affiliated with Anthropic, PBC. "Claude" is a trademark of Anthropic. This tool is a skill/plugin that works with Claude products but is developed and maintained independently. License: MIT.
