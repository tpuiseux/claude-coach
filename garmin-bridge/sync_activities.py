#!/usr/bin/env python3
"""Sync activities from Garmin Connect into claude-coach's coach.db.

The Garmin equivalent of `npx claude-coach sync` (Strava) - writes into the
exact same `activities` table Strava populates (see src/db/schema.ts), so
every existing skill query (coach, weekly-review) and view (weekly_volume,
recent_activities) keeps working unchanged; only the data source changes.
Historical Strava-sourced rows are left untouched - this only adds/updates
rows going forward, keyed by Garmin's own activityId (observed to be
numerically higher than any historical Strava ID, so there's no realistic
collision risk between the two id spaces).

Run `npx claude-coach init` once first, from the same directory, to create
the database - this script doesn't create the schema itself (see
src/db/schema.ts for why: single source of truth, shared with the web app).

Notably NOT populated: `suffer_score` (Strava's proprietary Relative Effort
has no Garmin equivalent on the same 0-300ish scale - Garmin's closest
concepts, activityTrainingLoad and aerobicTrainingEffect, are a different
metric on a different scale, and are preserved in raw_json instead of being
force-fit into that column) and the `streams` table (unused by any current
skill query, and was never populated by the Strava sync either).

Auth reuses garmin_lib.py's login flow and, by default, a separate
tokenstore from the push-workout bridge's legacy single-account mode
(~/.garminconnect) - pass --tokenstore to share one explicitly if you want.

Usage:
    python3 sync_activities.py                  # last 14 days (default)
    python3 sync_activities.py --days 60
    python3 sync_activities.py --start 2026-07-01 --end 2026-07-26
    python3 sync_activities.py --dedupe-all      # scan the whole table for
                                                  # already-synced duplicates,
                                                  # no Garmin login needed

Every normal sync run also dedupes automatically over the range it just
synced - see find_duplicate_groups()/dedupe_activities() below.
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from garmin_lib import call_with_retry, init_api

COACH_DB_PATH = Path(os.getenv("CLAUDE_COACH_DB_PATH", "~/.claude-coach/coach.db")).expanduser()

# Maps Garmin's activityType.typeKey to the Strava-style sport_type strings
# already used throughout coach.db and the skill queries that read it
# (e.g. "Run", "GravelRide") - keeps every existing query working unchanged.
SPORT_TYPE_MAP = {
    "running": "Run",
    "treadmill_running": "Run",
    "indoor_running": "Run",
    "track_running": "Run",
    "street_running": "Run",
    "ultra_run": "Run",
    "trail_running": "TrailRun",
    "cycling": "Ride",
    "road_biking": "Ride",
    "gravel_cycling": "GravelRide",
    "mountain_biking": "MountainBikeRide",
    "cyclocross": "Ride",
    "indoor_cycling": "VirtualRide",
    "virtual_ride": "VirtualRide",
    "lap_swimming": "Swim",
    "open_water_swimming": "Swim",
    "strength_training": "WeightTraining",
    "hiking": "Hike",
    "walking": "Walk",
    "multi_sport": "Workout",
    "fitness_equipment": "Workout",
}

# Fields to strip before storing raw_json - OAuth scope lists and profile
# image URLs, not activity data, just noise.
RAW_JSON_STRIP_KEYS = {
    "userRoles",
    "ownerProfileImageUrlSmall",
    "ownerProfileImageUrlMedium",
    "ownerProfileImageUrlLarge",
}

# --- Duplicate-recording detection ------------------------------------------
#
# Garmin sometimes logs the same real-world session twice (observed: paired
# device/app recording the same ride under two typeKeys within seconds of
# each other, e.g. "road_biking" + "cycling" for one ride). Left alone, this
# silently doubles volume in weekly_volume and anything built on it (ACWR,
# weekly-review's load read). Only running/cycling/swimming are covered below
# since that's where this has actually been observed; strength/hiking/etc.
# are left alone rather than guessing at a pattern that hasn't shown up.

SPORT_FAMILY = {
    "cycling": "cycle", "road_biking": "cycle", "gravel_cycling": "cycle",
    "mountain_biking": "cycle", "cyclocross": "cycle", "indoor_cycling": "cycle",
    "virtual_ride": "cycle",
    "running": "run", "treadmill_running": "run", "indoor_running": "run",
    "track_running": "run", "street_running": "run", "ultra_run": "run",
    "trail_running": "run",
    "lap_swimming": "swim", "open_water_swimming": "swim",
}

# Within a family, the more specific typeKey is preferred as the "primary"
# record when a duplicate is detected - it's the one that's consistently
# come from the actual recording device in observed cases, vs. a generic
# secondary entry.
SPECIFIC_TYPE_KEYS = {
    "road_biking", "gravel_cycling", "mountain_biking", "cyclocross",
    "indoor_cycling", "virtual_ride", "trail_running", "treadmill_running",
    "indoor_running", "track_running", "street_running", "ultra_run",
    "open_water_swimming",
}

DUPLICATE_TIME_WINDOW_SECONDS = 15 * 60
DUPLICATE_DISTANCE_TOLERANCE = 0.10  # 10%


def _parse_iso(start_date: str) -> datetime:
    return datetime.fromisoformat(start_date.replace("Z", "+00:00"))


def find_duplicate_groups(rows: list[dict]) -> list[list[dict]]:
    """Group DB rows (each needs id/sport_type/start_date/distance/raw_json)
    that look like duplicate recordings of the same real session. Each row's
    raw_json must be the parsed dict (not a JSON string) with activityType.typeKey.
    Returns a list of groups, each group being 2+ rows judged to be duplicates.
    """
    candidates = []
    for row in rows:
        type_key = ((row.get("raw_json") or {}).get("activityType") or {}).get("typeKey") or ""
        family = SPORT_FAMILY.get(type_key)
        if not family or not row.get("start_date") or row.get("distance") is None:
            continue
        candidates.append({**row, "_family": family, "_type_key": type_key, "_ts": _parse_iso(row["start_date"])})

    candidates.sort(key=lambda r: (r["_family"], r["_ts"]))

    groups: list[list[dict]] = []
    current: list[dict] = []
    for row in candidates:
        if current and row["_family"] == current[-1]["_family"]:
            gap = (row["_ts"] - current[-1]["_ts"]).total_seconds()
            ref_distance = current[0]["distance"] or 1
            distance_close = abs(row["distance"] - ref_distance) <= DUPLICATE_DISTANCE_TOLERANCE * ref_distance
            if gap <= DUPLICATE_TIME_WINDOW_SECONDS and distance_close:
                current.append(row)
                continue
        if len(current) > 1:
            groups.append(current)
        current = [row]
    if len(current) > 1:
        groups.append(current)

    return groups


def pick_primary(group: list[dict]) -> dict:
    def rank(row: dict) -> tuple:
        is_specific = row["_type_key"] in SPECIFIC_TYPE_KEYS
        duration = row.get("elapsed_time") or 0
        return (is_specific, duration, -row["id"])

    return max(group, key=rank)


def dedupe_activities(conn: sqlite3.Connection, start: str | None = None, end: str | None = None) -> int:
    """Remove duplicate-recording rows from `activities`. Scans the full table
    if start/end aren't given. Returns the number of rows removed."""
    query = "SELECT id, sport_type, start_date, distance, elapsed_time, raw_json FROM activities"
    params: list = []
    if start and end:
        query += " WHERE start_date BETWEEN ? AND ?"
        params = [start, end]

    rows = []
    for r in conn.execute(query, params).fetchall():
        try:
            raw = json.loads(r[5]) if r[5] else {}
        except json.JSONDecodeError:
            raw = {}
        rows.append(
            {"id": r[0], "sport_type": r[1], "start_date": r[2], "distance": r[3], "elapsed_time": r[4], "raw_json": raw}
        )

    removed = 0
    for group in find_duplicate_groups(rows):
        primary = pick_primary(group)
        for row in group:
            if row["id"] == primary["id"]:
                continue
            conn.execute("DELETE FROM activities WHERE id = ?", (row["id"],))
            removed += 1
            print(
                f"  Duplicate removed: {row['start_date']}  {row['sport_type']:10s}  id={row['id']}"
                f"  (kept id={primary['id']})"
            )
    conn.commit()
    return removed


def to_iso8601_utc(garmin_gmt_str: str | None) -> str | None:
    """'2026-07-24 05:59:56' -> '2026-07-24T05:59:56Z' (matches Strava's stored format)."""
    if not garmin_gmt_str:
        return None
    return garmin_gmt_str.replace(" ", "T") + "Z"


def map_sport_type(activity: dict) -> str:
    type_key = (activity.get("activityType") or {}).get("typeKey", "")
    if type_key in SPORT_TYPE_MAP:
        return SPORT_TYPE_MAP[type_key]
    # Fallback: title-case the raw Garmin key rather than silently dropping
    # unrecognized sports (e.g. "yoga" -> "Yoga").
    return type_key.replace("_", " ").title().replace(" ", "") if type_key else "Workout"


def first_present(activity: dict, *keys: str):
    for k in keys:
        if activity.get(k) is not None:
            return activity[k]
    return None


def map_activity(activity: dict) -> dict:
    event_type = (activity.get("eventType") or {}).get("typeKey")

    raw = {k: v for k, v in activity.items() if k not in RAW_JSON_STRIP_KEYS}

    return {
        "id": activity["activityId"],
        "name": activity.get("activityName"),
        "sport_type": map_sport_type(activity),
        "start_date": to_iso8601_utc(activity.get("startTimeGMT")),
        "elapsed_time": round(activity["elapsedDuration"]) if activity.get("elapsedDuration") is not None else None,
        "moving_time": round(activity["movingDuration"]) if activity.get("movingDuration") is not None else None,
        "distance": activity.get("distance"),
        "total_elevation_gain": activity.get("elevationGain"),
        "average_speed": activity.get("averageSpeed"),
        "max_speed": activity.get("maxSpeed"),
        "average_heartrate": activity.get("averageHR"),
        "max_heartrate": activity.get("maxHR"),
        "average_watts": activity.get("avgPower"),
        "max_watts": activity.get("maxPower"),
        "weighted_average_watts": activity.get("normPower"),
        "kilojoules": None,  # no direct Garmin equivalent, see module docstring
        "suffer_score": None,  # no direct Garmin equivalent, see module docstring
        "average_cadence": first_present(
            activity,
            "averageRunningCadenceInStepsPerMinute",
            "averageBikingCadenceInRevPerMinute",
        ),
        "calories": activity.get("calories"),
        "description": None,
        "workout_type": 1 if event_type == "race" else None,
        "gear_id": None,
        "raw_json": json.dumps(raw, default=str),
    }


def upsert(conn: sqlite3.Connection, row: dict) -> None:
    cols = list(row.keys())
    placeholders = ", ".join(f":{c}" for c in cols)
    col_list = ", ".join(cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id")
    conn.execute(
        f"INSERT INTO activities ({col_list}, synced_at) VALUES ({placeholders}, datetime('now')) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}, synced_at=datetime('now')",
        row,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=14, help="Number of days to sync (default: 14)")
    parser.add_argument("--start", help="Start date YYYY-MM-DD (overrides --days)")
    parser.add_argument("--end", help="End date YYYY-MM-DD (default: today)")
    parser.add_argument(
        "--tokenstore",
        default=os.getenv("GARMINTOKENS", str(Path("~/.garminconnect").expanduser())),
    )
    parser.add_argument("--db", default=str(COACH_DB_PATH), help="Path to coach.db")
    parser.add_argument(
        "--dedupe-all",
        action="store_true",
        help="Sync nothing: scan the whole activities table for existing duplicates",
    )
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        print(
            f"{db_path} doesn't exist yet. Run 'npx claude-coach init' first to create the "
            "database (see src/db/schema.ts - this script writes into an existing schema "
            "rather than creating its own copy of it).",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.dedupe_all:
        conn = sqlite3.connect(db_path)
        removed = dedupe_activities(conn)
        print(f"\n{removed} duplicate(s) removed from {db_path}")
        return

    end = date.fromisoformat(args.end) if args.end else date.today()
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days - 1)

    conn = sqlite3.connect(db_path)

    api = init_api(args.tokenstore)

    print(f"Fetching Garmin activities from {start} to {end}...")
    activities = call_with_retry(
        api.get_activities_by_date, start.isoformat(), end.isoformat(), sortorder="asc", label="activities"
    )

    synced = 0
    for activity in activities:
        row = map_activity(activity)
        upsert(conn, row)
        synced += 1
        print(f"  {row['start_date']}  {row['sport_type']:12s}  {row['name']}")

    conn.commit()
    print(f"\n{synced} activities synced into {db_path}")

    removed = dedupe_activities(conn, start.isoformat(), end.isoformat())
    if removed:
        print(f"{removed} duplicate(s) detected and removed (see details above).")


if __name__ == "__main__":
    main()
