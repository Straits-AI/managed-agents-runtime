#!/usr/bin/env python3
"""Sync BytePlus STS temporary credentials from the `bp login` cache into the
gitignored .env, without ever printing secret material.

The bp CLI caches console-login STS credentials in
~/.byteplus/login/cache/<hash>.json as access_token.{access_key_id,
secret_access_key, session_token}, valid for expires_in seconds (currently
900s = 15 minutes). This script first runs a harmless read-only bp call so
the CLI refreshes a stale cache via its refresh token, then copies the
triplet into .env.

Rerun before any cloud operation batch; long processes should be restarted
(or re-exec'd) after a refresh since they read .env at startup.

Usage: python3 scripts/refresh-creds.py [--profile dev] [--env-file .env] [--no-refresh]
Prints only: masked key id, expiry, and which .env keys were written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import stat
import subprocess
import sys

ENV_KEYS = {
    "access_key_id": "BYTEPLUS_ACCESS_KEY_ID",
    "secret_access_key": "BYTEPLUS_SECRET_ACCESS_KEY",
    "session_token": "BYTEPLUS_SESSION_TOKEN",
}


def fail(msg: str) -> "sys.NoReturn":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def profile_login_session(profile: str) -> str:
    path = os.path.expanduser("~/.byteplus/config.json")
    try:
        with open(path) as f:
            profiles = json.load(f).get("profiles") or {}
    except FileNotFoundError:
        fail(f"{path} not found — run `bp login` first")
    if profile not in profiles:
        fail(f"profile {profile!r} not in bp config (have: {', '.join(profiles)})")
    session = profiles[profile].get("login-session", "")
    if not session:
        fail(f"profile {profile!r} has no login-session — not a console-login profile?")
    return session


def bp_refresh(profile: str, region: str) -> None:
    """Any authenticated read-only call makes bp refresh a stale STS cache."""
    result = subprocess.run(
        ["bp", "sts", "GetCallerIdentity", f"---profile", profile, f"---region", region],
        capture_output=True,  # never echo — output could carry identity details
        timeout=60,
    )
    if result.returncode != 0:
        fail(
            f"bp credential refresh failed (exit {result.returncode}) — "
            f"try `bp login` for profile {profile!r}"
        )


def load_cache(login_session: str) -> dict:
    for path in glob.glob(os.path.expanduser("~/.byteplus/login/cache/*.json")):
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("login_session") == login_session:
            return data
    fail("no login cache entry matches this profile — run `bp login`")


def cache_expiry(cache: dict) -> dt.datetime:
    issued_raw = cache.get("issued_at", "")
    try:
        issued = dt.datetime.fromisoformat(str(issued_raw).replace("Z", "+00:00"))
    except ValueError:
        fail(f"unparseable issued_at {issued_raw!r}")
    return issued + dt.timedelta(seconds=int(cache.get("expires_in", 0)))


def upsert_env(env_file: str, values: dict[str, str]) -> list[str]:
    lines: list[str] = []
    if os.path.exists(env_file):
        with open(env_file) as f:
            lines = f.read().splitlines()
    seen: set[str] = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in values:
            lines[i] = f"{key}={values[key]}"
            seen.add(key)
    for key, value in values.items():
        if key not in seen:
            lines.append(f"{key}={value}")
    with open(env_file, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(env_file, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    return sorted(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="dev")
    parser.add_argument("--region", default="ap-southeast-1")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--no-refresh", action="store_true")
    args = parser.parse_args()

    login_session = profile_login_session(args.profile)
    if not args.no_refresh:
        bp_refresh(args.profile, args.region)

    cache = load_cache(login_session)
    expires = cache_expiry(cache)
    remaining = (expires - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if remaining < 120:
        fail("cached STS credentials expire in <2 minutes even after refresh — run `bp login`")

    token = cache.get("access_token") or {}
    values: dict[str, str] = {}
    for src, dst in ENV_KEYS.items():
        value = token.get(src, "")
        if not value:
            fail(f"login cache is missing access_token.{src}")
        values[dst] = value

    written = upsert_env(args.env_file, values)
    masked = values["BYTEPLUS_ACCESS_KEY_ID"][:4] + "…"
    print(f"synced {', '.join(written)} to {args.env_file} (0600)")
    print(f"key id {masked}, valid until {expires.isoformat()} ({int(remaining)}s left)")


if __name__ == "__main__":
    main()
