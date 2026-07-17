#!/usr/bin/env python3
"""Fetch a ModelArk API key via `bp ark GetApiKey` and write it straight into
the gitignored .env — the key never reaches stdout, argv, or logs.

Usage: python3 scripts/get-ark-key.py [--profile dev] [--region ap-southeast-1]
         [--model seed-2-0-lite-260228] [--days 7] [--env-file .env]
Prints only: masked key prefix, expiry, sanitized request id / error codes.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import stat
import subprocess
import sys

SECRETISH = ("key", "token", "secret", "credential", "authorization", "signature")


def sanitize(obj: object) -> object:
    """Recursively redact secret-bearing fields before anything is printed."""
    if isinstance(obj, dict):
        return {
            k: "<redacted>" if any(s in k.lower() for s in SECRETISH) else sanitize(v)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj


def fail(msg: str) -> "sys.NoReturn":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def upsert_env(env_file: str, key: str, value: str) -> None:
    lines: list[str] = []
    if os.path.exists(env_file):
        with open(env_file) as f:
            lines = f.read().splitlines()
    for i, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == key:
            lines[i] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    with open(env_file, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(env_file, stat.S_IRUSR | stat.S_IWUSR)  # 0600


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="dev")
    parser.add_argument("--region", default="ap-southeast-1")
    parser.add_argument(
        "--endpoint-id",
        required=True,
        help="Ark inference endpoint ID (ep-...); the key is scoped to it and "
        "OpenAI-compatible calls use it as the model parameter",
    )
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--env-file", default=".env")
    args = parser.parse_args()

    # Official contract (volcengine-go-sdk ark GetApiKeyInput):
    # ResourceType in {endpoint, bot, action}; ResourceIds are ep-... IDs.
    body = {
        "DurationSeconds": args.days * 86400,
        "ResourceType": "endpoint",
        "ResourceIds": [args.endpoint_id],
    }
    result = subprocess.run(
        [
            "bp", "ark", "GetApiKey",
            "---profile", args.profile,
            "---region", args.region,
            "--body", json.dumps(body),
        ],
        capture_output=True,  # stdout carries the key — never echo it
        timeout=60,
        text=True,
    )
    if result.returncode != 0:
        # stderr from bp may embed the request body but never the key; the
        # first line carries the error code, the last the request id.
        lines = (result.stderr or result.stdout).strip().splitlines()
        detail = " | ".join(line.strip() for line in (lines[:1] + lines[-1:]))
        fail(f"bp ark GetApiKey failed (exit {result.returncode}): {detail[:300]}")

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("bp returned non-JSON output (not shown — may contain secrets)")

    err = (parsed.get("ResponseMetadata") or {}).get("Error")
    request_id = (parsed.get("ResponseMetadata") or {}).get("RequestId", "?")
    if err:
        fail(f"GetApiKey error {err.get('Code')}: {err.get('Message')} (request {request_id})")

    api_key = (parsed.get("Result") or {}).get("ApiKey", "")
    if not api_key:
        fail(
            "no ApiKey in response; result fields: "
            f"{json.dumps(sanitize(parsed.get('Result') or {}))[:300]} (request {request_id})"
        )

    upsert_env(args.env_file, "ARK_API_KEY", api_key)
    upsert_env(args.env_file, "ARK_MODEL", args.endpoint_id)
    expiry = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=args.days)
    print(f"ARK_API_KEY ({api_key[:4]}…) and ARK_MODEL={args.endpoint_id} written to {args.env_file} (0600)")
    print(f"scope: endpoint {args.endpoint_id}; expires ~{expiry.date()} (request {request_id})")


if __name__ == "__main__":
    main()
