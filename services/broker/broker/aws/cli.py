"""Sandbox-side AWS tools — credential_process helper + request CLI.

DESIGN BOILERPLATE. These ship in the SANDBOX image (not the broker pod) and call
the broker with the pod's projected SA token (same auth as agent-broker.sh:
BROKER_URL + /var/run/secrets/broker/token). Two entry points:

  scooter-aws-credentials --profile <name>
      AWS credential_process helper. Resolves <profile> -> account -> the
      conversation's ACTIVE permission request, prints the credential_process
      JSON. If no active grant: exit non-zero with a verbose, actionable error
      (how to run `scooter-aws request …`). No caching.

  scooter-aws <request|status|accounts|revoke> …
      The request/management CLI the agent (via a skill) uses to ASK for access.

~/.aws/config is generated at sandbox start (entrypoint) from the account
ConfigMap: one [profile <name>] per enabled account, each with
  credential_process = scooter-aws-credentials --profile <name>
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def _credentials_entry() -> None:
    """Console-script entry: `scooter-aws-credentials`."""
    sys.exit(credentials_main(sys.argv[1:]))


def _cli_entry() -> None:
    """Console-script entry: `scooter-aws`."""
    sys.exit(cli_main(sys.argv[1:]))


# --- broker client (SA-token auth, like agent-broker.sh) -----------------
def _broker_base() -> str:
    url = os.environ.get("BROKER_URL", "").rstrip("/")
    if not url:
        raise SystemExit("BROKER_URL is not set")
    return url


def _token() -> str:
    path = os.environ.get("BROKER_TOKEN_PATH", "/var/run/secrets/broker/token")
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError as exc:
        raise SystemExit(f"no broker token at {path}: {exc}")


def _call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    """Call the broker's aws provider routes (prefix /aws/aws/...) with the SA
    token. Returns (status_code, parsed_json)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{_broker_base()}/aws/aws/{path.lstrip('/')}",
        data=data, method=method,
        headers={"Authorization": f"Bearer {_token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


# --- credential_process helper ------------------------------------------
def credentials_main(argv: list[str] | None = None) -> int:
    """`scooter-aws-credentials --profile <name>` — AWS credential_process helper.

    Resolves <profile> -> the conversation's most recent ACTIVE request for it.
    Active: print the credential_process JSON, return 0. Otherwise: write a
    verbose, actionable error to stderr and return 1 (fail closed). No cache.
    """
    ap = argparse.ArgumentParser(prog="scooter-aws-credentials")
    ap.add_argument("--profile", required=True)
    args = ap.parse_args(argv)
    profile = args.profile

    # Find an active request for this profile/account. (List endpoint is the
    # audit query scoped to the caller's conversation by the broker.)
    status, body = _call("GET", f"requests?target_account={profile}")
    active = None
    if status == 200:
        for r in body.get("requests", []):
            if r.get("status") == "active" and r.get("target_account") == profile:
                active = r
                break

    if active is None:
        sys.stderr.write(_not_granted_message(profile))
        return 1

    # Re-fetch the single request to get fresh credentials (status carries them).
    status, req = _call("GET", active["request_id"])
    creds = (req or {}).get("credentials")
    if status != 200 or not creds:
        sys.stderr.write(_not_granted_message(profile))
        return 1

    print(json.dumps({
        "Version": 1,
        "AccessKeyId": creds["access_key_id"],
        "SecretAccessKey": creds["secret_access_key"],
        "SessionToken": creds["session_token"],
        "Expiration": creds["expires_at"],
    }))
    return 0


def _not_granted_message(profile: str) -> str:
    return (
        f"\nAWS access for profile '{profile}' is not granted.\n\n"
        f"Request it (then wait for approval), e.g.:\n"
        f"  scooter-aws request --profile {profile} \\\n"
        f"      --policy policy.json --justification \"why you need it\"\n\n"
        f"Check status:   scooter-aws status <request_id>\n"
        f"List accounts:  scooter-aws accounts\n"
    )


# --- request / management CLI -------------------------------------------
def cli_main(argv: list[str] | None = None) -> int:
    """`scooter-aws <request|status|accounts|revoke>` — the request/management CLI."""
    ap = argparse.ArgumentParser(prog="scooter-aws")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_req = sub.add_parser("request", help="request a scoped AWS permission")
    p_req.add_argument("--profile", required=True, help="account profile/alias")
    p_req.add_argument("--policy", help="path to an IAM policy JSON (or - for stdin)")
    p_req.add_argument("--managed", action="append", default=[], help="managed policy ARN (repeatable)")
    p_req.add_argument("--justification", required=True)

    sub.add_parser("accounts", help="list available account profiles")
    p_st = sub.add_parser("status", help="show a request's status")
    p_st.add_argument("request_id")
    p_rv = sub.add_parser("revoke", help="revoke a request")
    p_rv.add_argument("request_id")

    args = ap.parse_args(argv)

    if args.cmd == "accounts":
        _, body = _call("GET", "accounts")
        print(json.dumps(body.get("accounts", {}), indent=2))
        return 0

    if args.cmd == "status":
        status, body = _call("GET", args.request_id)
        print(json.dumps(body, indent=2))
        return 0 if status == 200 else 1

    if args.cmd == "revoke":
        status, body = _call("DELETE", args.request_id)
        print(json.dumps(body, indent=2))
        return 0 if status == 200 else 1

    if args.cmd == "request":
        policy_doc = None
        if args.policy:
            raw = sys.stdin.read() if args.policy == "-" else open(args.policy).read()
            policy_doc = json.loads(raw)
        if policy_doc is None and not args.managed:
            ap.error("provide --policy and/or --managed")
        status, body = _call("POST", "request", {
            "target_account": args.profile,
            "policy_document": policy_doc,
            "managed_policy_arns": args.managed,
            "justification": args.justification,
        })
        if status == 201:
            print(f"requested: {body['request_id']} (status: {body['status']}); waiting for approval.")
            return 0
        sys.stderr.write(f"request failed ({status}): {json.dumps(body.get('detail', body))}\n")
        return 1

    return 2


# --- helpers (shared) ----------------------------------------------------
def render_aws_config(account_registry: dict[str, dict], *, helper_path: str = "scooter-aws-credentials") -> str:
    """Render ~/.aws/config: one [profile <name>] per ENABLED account, each with
    `credential_process = {helper_path} --profile <name>` (+ region). Generated at
    sandbox start from the account ConfigMap — no static keys, single source of
    truth with the broker's registry.
    """
    blocks: list[str] = []
    for name, acct in account_registry.items():
        if not acct.get("enabled", False):
            continue
        lines = [f"[profile {name}]", f"credential_process = {helper_path} --profile {name}"]
        region = acct.get("region")
        if region:
            lines.append(f"region = {region}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + ("\n" if blocks else "")
