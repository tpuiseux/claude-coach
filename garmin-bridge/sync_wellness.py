#!/usr/bin/env python3
"""Sync daily recovery/wellness data from Garmin Connect into a local SQLite db.

Separate from coach.db (which holds activities, see sync_activities.py in this
same directory) - Garmin Connect exposes recovery signals that don't fit in
that table: sleep, HRV, all-day stress, Body Battery, morning training
readiness, training status/load (including ACWR - acute:chronic workload
ratio, a standard injury-risk signal), and VO2max. Used by the weekly-review
skill's "Pull Recovery/Wellness Data" step.

Auth reuses the same token store as sync_activities.py and the workout-push
bridge (garmin_bridge.py) - ~/.garminconnect by default - so logging in once
covers all three.

Usage:
    python3 sync_wellness.py                  # last 14 days (default)
    python3 sync_wellness.py --days 30
    python3 sync_wellness.py --start 2026-07-01 --end 2026-07-26
"""

import argparse
import json
import os
import sqlite3
from datetime import date, timedelta
from pathlib import Path

from garminconnect import Garmin

from garmin_lib import call_with_retry, init_api

DB_PATH = Path(os.getenv("GARMIN_HEALTH_DB", "~/.garmin-health/wellness.db")).expanduser()
SCHEMA_PATH = Path(__file__).resolve().parent / "wellness_schema.sql"


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()


def safe_get(d, *path, default=None):
    """Walk a nested dict/list path, returning `default` if anything along
    the way is missing or the wrong shape (Garmin's endpoints frequently omit
    fields on days with no data, e.g. no HRV reading if the watch wasn't worn
    overnight)."""
    cur = d
    for key in path:
        if cur is None:
            return default
        try:
            cur = cur[key]
        except (KeyError, IndexError, TypeError):
            return default
    return cur if cur is not None else default


def fetch_day(api: Garmin, day: str, body_battery_by_date: dict) -> dict:
    raw: dict = {}
    row: dict = {"date": day}

    try:
        sleep = call_with_retry(api.get_sleep_data, day, label="sleep")
        raw["sleep"] = sleep
        dto = sleep.get("dailySleepDTO") or {}
        scores = dto.get("sleepScores") or {}
        row["sleep_score"] = safe_get(scores, "overall", "value")
        row["sleep_seconds"] = dto.get("sleepTimeSeconds")
        row["deep_sleep_seconds"] = dto.get("deepSleepSeconds")
        row["light_sleep_seconds"] = dto.get("lightSleepSeconds")
        row["rem_sleep_seconds"] = dto.get("remSleepSeconds")
        row["awake_sleep_seconds"] = dto.get("awakeSleepSeconds")
        row["avg_sleep_stress"] = dto.get("avgSleepStress")
    except Exception as e:
        print(f"  [sleep] {day}: {e}")

    try:
        stress = call_with_retry(api.get_stress_data, day, label="stress")
        raw["stress"] = stress
        row["avg_stress"] = stress.get("avgStressLevel")
        row["max_stress"] = stress.get("maxStressLevel")
    except Exception as e:
        print(f"  [stress] {day}: {e}")

    try:
        rhr = call_with_retry(api.get_rhr_day, day, label="rhr")
        raw["rhr"] = rhr
        entries = safe_get(rhr, "allMetrics", "metricsMap", "WELLNESS_RESTING_HEART_RATE", default=[])
        row["resting_hr"] = entries[0].get("value") if entries else None
    except Exception as e:
        print(f"  [rhr] {day}: {e}")

    try:
        hrv = call_with_retry(api.get_hrv_data, day, label="hrv")
        raw["hrv"] = hrv
        summary = (hrv or {}).get("hrvSummary") or {}
        row["hrv_last_night_avg"] = summary.get("lastNightAvg")
        row["hrv_weekly_avg"] = summary.get("weeklyAvg")
        row["hrv_status"] = summary.get("status")
    except Exception as e:
        print(f"  [hrv] {day}: {e}")

    try:
        readiness = call_with_retry(api.get_morning_training_readiness, day, label="training_readiness")
        raw["training_readiness"] = readiness
        if readiness:
            row["training_readiness_score"] = readiness.get("score")
            row["training_readiness_level"] = readiness.get("level")
            row["training_readiness_feedback"] = readiness.get("feedbackLong")
    except Exception as e:
        print(f"  [training_readiness] {day}: {e}")

    try:
        status = call_with_retry(api.get_training_status, day, label="training_status")
        raw["training_status"] = status
        row["vo2max"] = safe_get(status, "mostRecentVO2Max", "generic", "vo2MaxPreciseValue")
        latest = safe_get(status, "mostRecentTrainingStatus", "latestTrainingStatusData", default={}) or {}
        first_device = next(iter(latest.values()), {})
        row["training_status"] = first_device.get("trainingStatusFeedbackPhrase")
        acute = first_device.get("acuteTrainingLoadDTO") or {}
        row["acute_training_load"] = acute.get("dailyTrainingLoadAcute")
        row["chronic_training_load"] = acute.get("dailyTrainingLoadChronic")
        row["acwr"] = acute.get("dailyAcuteChronicWorkloadRatio")
        row["acwr_status"] = acute.get("acwrStatus")
    except Exception as e:
        print(f"  [training_status] {day}: {e}")

    bb = body_battery_by_date.get(day)
    if bb:
        row["body_battery_high"] = bb.get("charged")
        row["body_battery_low"] = bb.get("drained")

    row["raw_json"] = json.dumps(raw, default=str)
    return row


def fetch_body_battery_range(api: Garmin, start: str, end: str) -> dict:
    try:
        entries = call_with_retry(api.get_body_battery, start, end, label="body_battery")
    except Exception as e:
        print(f"  [body_battery] {start}..{end}: {e}")
        return {}
    return {e.get("date"): e for e in entries if e.get("date")}


def upsert(conn: sqlite3.Connection, row: dict) -> None:
    cols = list(row.keys())
    placeholders = ", ".join(f":{c}" for c in cols)
    col_list = ", ".join(cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "date")
    conn.execute(
        f"INSERT INTO daily_wellness ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT(date) DO UPDATE SET {updates}, synced_at=datetime('now')",
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
    parser.add_argument("--db", default=str(DB_PATH), help="Path to wellness.db")
    args = parser.parse_args()

    end = date.fromisoformat(args.end) if args.end else date.today()
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days - 1)

    db_path = Path(args.db).expanduser()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    init_db(conn)

    api = init_api(args.tokenstore)

    bb_by_date = fetch_body_battery_range(api, start.isoformat(), end.isoformat())

    day = start
    synced = 0
    while day <= end:
        day_str = day.isoformat()
        print(f"Sync {day_str}...")
        row = fetch_day(api, day_str, bb_by_date)
        upsert(conn, row)
        conn.commit()
        synced += 1
        day += timedelta(days=1)

    print(f"\n{synced} day(s) synced into {db_path}")


if __name__ == "__main__":
    main()
