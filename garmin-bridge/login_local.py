#!/usr/bin/env python3
"""Log in to Garmin Connect from this machine and save the session to a file.

For when the server running garmin_bridge.py can't log in itself: Garmin's
SSO (behind Cloudflare) often blocks password logins from datacenter IPs
with a 403/429, while token refreshes from those same IPs still work. So:
log in here, from a residential connection, then copy the saved session to
the bridge's per-user tokenstore (<multiuser-tokenstore-dir>/<userId>.json).

Usage:
    ./venv/bin/python3 login_local.py --out ~/garmin-token.json

Prompts for email, password and (if enabled) the MFA code. Nothing is sent
anywhere but Garmin; the output file holds session tokens, not the password.
"""

import argparse
import os
from getpass import getpass
from pathlib import Path

from garminconnect import Garmin


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="Where to write the session (a .json file)")
    args = parser.parse_args()

    out = Path(args.out).expanduser()
    if out.suffix != ".json":
        parser.error("--out must end in .json")

    # Same trap as the bridge: with GARMINTOKENS set, login() would load
    # that saved session instead of using the credentials typed below.
    os.environ.pop("GARMINTOKENS", None)

    email = input("Email Garmin: ").strip()
    password = getpass("Mot de passe Garmin: ")
    garmin = Garmin(email=email, password=password, prompt_mfa=lambda: input("Code MFA: ").strip())
    garmin.login()

    out.parent.mkdir(parents=True, exist_ok=True)
    out.touch(mode=0o600, exist_ok=True)
    out.chmod(0o600)
    garmin.client.dump(str(out))
    print(f"Connecte en tant que {garmin.display_name} ({garmin.full_name}).")
    print(f"Session enregistree dans {out}")


if __name__ == "__main__":
    main()
