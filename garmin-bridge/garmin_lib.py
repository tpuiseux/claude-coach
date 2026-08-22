"""Shared Garmin Connect helpers: auth, pace zones, step builders, and the
demo workout definition. Used by both push_to_garmin.py (CLI) and
garmin_bridge.py (local HTTP bridge for the HTML viewer's button).
"""

import json
import os
import sys
from getpass import getpass
from pathlib import Path

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from garminconnect.workout import (
    RunningWorkout,
    TargetType,
    WorkoutSegment,
    create_cooldown_step,
    create_interval_step,
    create_recovery_step,
    create_repeat_group,
    create_warmup_step,
)

PLAN_PATH = Path(__file__).resolve().parent.parent / "10km-stade-toulousain-2026-09-06.json"


# ---------------------------------------------------------------------------
# Auth — token-cached, MFA-aware. Mirrors the library's own recommended
# pattern (see cyberjunky/python-garminconnect example.py).
# ---------------------------------------------------------------------------


def init_api(tokenstore: str) -> Garmin:
    try:
        garmin = Garmin()
        garmin.login(tokenstore)
        print(f"Connecte via le token sauvegarde ({tokenstore}).")
        return garmin
    except (GarminConnectAuthenticationError, GarminConnectConnectionError):
        print("Pas de token valide, connexion requise.")

    while True:
        try:
            email = os.getenv("GARMIN_EMAIL") or input("Email Garmin: ").strip()
            password = os.getenv("GARMIN_PASSWORD") or getpass("Mot de passe Garmin: ")
            garmin = Garmin(
                email=email,
                password=password,
                prompt_mfa=lambda: input("Code MFA: ").strip(),
            )
            garmin.login(tokenstore)
            print(f"Connexion reussie, token sauvegarde dans: {tokenstore}")
            return garmin
        except GarminConnectAuthenticationError:
            print("Identifiants incorrects, reessaie.")
            continue
        except GarminConnectTooManyRequestsError as err:
            print(f"Trop de tentatives de connexion: {err}")
            sys.exit(1)
        except GarminConnectConnectionError as err:
            print(f"Erreur de connexion: {err}")
            sys.exit(1)


# ---------------------------------------------------------------------------
# Multi-tenant auth — same underlying login/MFA machinery as init_api above,
# but split into non-interactive steps so an HTTP handler can drive it on
# behalf of a specific user (see garmin_bridge.py's /garmin/login and
# /garmin/mfa routes). No prompt_mfa callback: the caller collects the code
# from its own UI and calls resume_mfa() explicitly.
# ---------------------------------------------------------------------------


def login_with_credentials(email: str, password: str) -> tuple[Garmin, str | None]:
    """Start a fresh login. Returns (garmin, mfa_status): mfa_status is
    falsy when login is already complete, truthy when resume_mfa() with a
    code is required before the session is usable. Does NOT persist a
    tokenstore - call save_tokenstore() once the session is confirmed
    complete (immediately here if mfa_status is falsy, or after resume_mfa
    succeeds otherwise), since garminconnect's own dump-after-login logic is
    skipped in this return_on_mfa mode.
    """
    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    mfa_status, _ = garmin.login()
    return garmin, mfa_status


def resume_mfa(garmin: Garmin, code: str) -> None:
    """Complete a login started by login_with_credentials() once it reported
    mfa_status. Must be called on the SAME Garmin instance - the MFA
    challenge state lives in that object's underlying client, not in
    anything serializable we could hand back across a request boundary.
    """
    garmin.resume_login({}, code)


def save_tokenstore(garmin: Garmin, tokenstore: str) -> None:
    Path(tokenstore).parent.mkdir(parents=True, exist_ok=True)
    garmin.client.dump(tokenstore)


def login_from_tokenstore(tokenstore: str) -> Garmin:
    """Load a previously-saved session for one user. Raises
    GarminConnectAuthenticationError/GarminConnectConnectionError if the
    tokenstore is missing or the session can't be refreshed - the caller
    (garmin_bridge.py) treats that as "not connected, reconnect via the UI"
    rather than falling back to an interactive prompt.
    """
    garmin = Garmin()
    garmin.login(tokenstore)
    return garmin


# ---------------------------------------------------------------------------
# Pace zones — read from the plan JSON so the script always matches whatever
# paces were computed for the current goal time, instead of hardcoding them.
# ---------------------------------------------------------------------------


def load_pace_zones(plan_path: Path) -> dict[str, tuple[str, str]]:
    plan = json.loads(plan_path.read_text())
    zones: dict[str, tuple[str, str]] = {}
    for z in plan["zones"]["run"]["pace"]["zones"]:
        key = z["name"].split(" ")[0].lower()  # "Threshold (T)" -> "threshold"
        zones[key] = (z["low"], z["high"])  # (allure lente, allure rapide)
    return zones


def pace_to_speed_mps(pace: str) -> float:
    minutes, seconds = pace.replace("/km", "").split(":")
    return 1000.0 / (int(minutes) * 60 + int(seconds))


def pace_zone_target(zone: tuple[str, str]) -> tuple[dict, float, float]:
    slow, fast = zone
    return {
        "workoutTargetTypeId": TargetType.PACE_ZONE,
        "workoutTargetTypeKey": "pace.zone",
        "displayOrder": TargetType.PACE_ZONE,
    }, pace_to_speed_mps(slow), pace_to_speed_mps(fast)


# ---------------------------------------------------------------------------
# Step builders, with a shared step_order counter (Garmin numbers steps
# sequentially across the whole workout, repeat-group container included).
# ---------------------------------------------------------------------------


class StepOrder:
    def __init__(self) -> None:
        self.n = 0

    def next(self) -> int:
        self.n += 1
        return self.n


def with_pace(step, zone: tuple[str, str] | None):
    if zone is None:
        return step
    target_type, value_one, value_two = pace_zone_target(zone)
    step.targetType = target_type
    step.targetValueOne = value_one
    step.targetValueTwo = value_two
    return step


def warmup(order: StepOrder, minutes: float, zone=None):
    return with_pace(create_warmup_step(minutes * 60, step_order=order.next()), zone)


def cooldown(order: StepOrder, minutes: float, zone=None):
    return with_pace(create_cooldown_step(minutes * 60, step_order=order.next()), zone)


def interval(order: StepOrder, seconds: float, zone=None):
    return with_pace(create_interval_step(seconds, step_order=order.next()), zone)


def recovery(order: StepOrder, seconds: float, zone=None):
    return with_pace(create_recovery_step(seconds, step_order=order.next()), zone)


def repeat(order: StepOrder, iterations: int, build_children):
    """build_children(order) -> list[step]. The group claims its step_order first."""
    group_order = order.next()
    children = build_children(order)
    return create_repeat_group(iterations, children, step_order=group_order)


# ---------------------------------------------------------------------------
# The demo workout: Week 2 / Wednesday from the plan ("Threshold Intervals").
#   Warm-up: 15min easy + 4x20s strides.
#   Main: 3 x 6min @ Threshold pace (4:07-4:17/km), 90s jog recovery.
#   Cool-down: 10min easy.
# ---------------------------------------------------------------------------


def build_week2_wednesday_threshold(zones: dict[str, tuple[str, str]]) -> RunningWorkout:
    order = StepOrder()
    steps = [
        warmup(order, 15, zones["easy"]),
        repeat(
            order,
            4,
            lambda o: [
                interval(o, 20, zones["repetition"]),
                recovery(o, 40, zones["easy"]),
            ],
        ),
        repeat(
            order,
            3,
            lambda o: [
                interval(o, 6 * 60, zones["threshold"]),
                recovery(o, 90, zones["easy"]),
            ],
        ),
        cooldown(order, 10, zones["easy"]),
    ]
    total_secs = int(15 * 60 + 4 * (20 + 40) + 3 * (6 * 60 + 90) + 10 * 60)
    return RunningWorkout(
        workoutName="S2 Mer - Seuil (3x6min)",
        estimatedDurationInSecs=total_secs,
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=steps,
            )
        ],
    )
