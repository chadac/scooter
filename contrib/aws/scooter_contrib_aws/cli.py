"""Sandbox-side AWS tools: the credential_process helper and the request CLI.

These ship in the sandbox image and call the broker with the pod's projected SA
token. `scooter-aws-credentials --profile <name>` resolves the conversation's active
grant for the profile and prints credential_process JSON, failing closed otherwise;
`scooter-aws <request|escalate|status|accounts|refresh|revoke>` is the CLI the agent
uses to ask for access. ~/.aws/config is rendered at sandbox start with one profile
per enabled account.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


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
    """Call the broker's aws provider routes (prefix /aws/aws/...) with the SA token, returning (status_code, parsed_json)."""
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
        # A non-JSON error body is kept as raw text so the caller can surface it.
        raw = b""
        try:
            raw = e.read() or b""
        except Exception:
            pass
        try:
            return e.code, json.loads(raw or b"{}")
        except Exception:
            return e.code, {"error": raw.decode("utf-8", "replace").strip()}


# --- credential_process helper ------------------------------------------
def credentials_main(argv: list[str] | None = None) -> int:
    """`scooter-aws-credentials --profile <name>`, the AWS credential_process helper; `--render-config <accounts.json>` prints ~/.aws/config instead."""
    ap = argparse.ArgumentParser(prog="scooter-aws-credentials")
    ap.add_argument("--profile")
    ap.add_argument("--render-config", help="print ~/.aws/config from an accounts.json registry")
    args = ap.parse_args(argv)

    if args.render_config:
        with open(args.render_config) as f:
            registry = json.load(f)
        sys.stdout.write(render_aws_config(registry, helper_path="scooter-aws-credentials"))
        return 0
    if not args.profile:
        ap.error("--profile is required")
    profile = args.profile

    # The list endpoint is scoped to the caller's conversation by the broker.
    status, body = _call("GET", f"requests?target_account={profile}")
    active = None
    if status == 200:
        active = _pick_active_request(body.get("requests", []), profile)

    if active is None:
        sys.stderr.write(_not_granted_message(profile))
        return 1

    # The single-request status carries fresh credentials.
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


def _pick_active_request(requests: list, profile: str) -> dict | None:
    """Pick the newest active request for `profile`, preferring one whose STS token has not expired."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()

    def _is_active(r: dict) -> bool:
        return r.get("status") == "active" and r.get("target_account") == profile

    active = [r for r in requests if _is_active(r)]
    if not active:
        return None

    def _newest(rs: list) -> dict:
        return max(rs, key=lambda r: r.get("requested_at") or "")

    fresh = [r for r in active if (r.get("expires_at") or "9999") > now]
    return _newest(fresh) if fresh else _newest(active)


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
    """`scooter-aws <request|escalate|status|accounts|refresh|revoke>` — the request/management CLI."""
    ap = argparse.ArgumentParser(prog="scooter-aws")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_req = sub.add_parser("request", help="request a scoped AWS permission")
    p_req.add_argument("--profile", required=True, help="account profile/alias")
    p_req.add_argument("--policy", help="path to an IAM policy JSON (or - for stdin)")
    p_req.add_argument("--managed", action="append", default=[], help="managed policy ARN (repeatable)")
    p_req.add_argument("--justification", required=True)

    # escalate has the shape of request plus the parent request id, which the broker supersedes once this is approved.
    p_esc = sub.add_parser("escalate", help="request MORE permissions, expanding an existing request")
    p_esc.add_argument("request_id", help="the existing request to expand (its request_id)")
    p_esc.add_argument("--profile", required=True, help="account profile/alias (same account as the parent)")
    p_esc.add_argument("--policy", help="path to an IAM policy JSON with the ADDITIONAL scope (or - for stdin)")
    p_esc.add_argument("--managed", action="append", default=[], help="managed policy ARN (repeatable)")
    p_esc.add_argument("--justification", required=True)

    sub.add_parser("accounts", help="list available account profiles")
    p_st = sub.add_parser("status", help="show a request's status")
    p_st.add_argument("request_id")
    p_rf = sub.add_parser("refresh", help="force fresh STS credentials for an active request (within the role TTL)")
    p_rf.add_argument("request_id")
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

    if args.cmd == "refresh":
        status, body = _call("POST", f"{args.request_id}/refresh")
        print(json.dumps(body, indent=2))
        return 0 if status == 200 else 1

    if args.cmd == "revoke":
        status, body = _call("DELETE", args.request_id)
        print(json.dumps(body, indent=2))
        return 0 if status == 200 else 1

    if args.cmd in ("request", "escalate"):
        policy_doc = None
        if args.policy:
            raw = sys.stdin.read() if args.policy == "-" else open(args.policy).read()
            policy_doc = json.loads(raw)
        if policy_doc is None and not args.managed:
            ap.error("provide --policy and/or --managed")
        req_body = {
            "target_account": args.profile,
            "policy_document": policy_doc,
            "managed_policy_arns": args.managed,
            "justification": args.justification,
        }
        route = "request"
        if args.cmd == "escalate":
            route = "escalate"
            req_body["parent_request_id"] = args.request_id
        # The agent-host injects CONVERSATION_URL into the sandbox so the request links back to where the human approves.
        conv_url = os.environ.get("CONVERSATION_URL")
        if conv_url:
            req_body["conversation_url"] = conv_url
        status, body = _call("POST", route, req_body)
        if status == 201:
            rid = body["request_id"]
            if body.get("status") == "active":
                print(f"requested: {rid} — AUTO-APPROVED by the account's approval rules. Credentials are ready; use `aws --profile {args.profile} …`.")
            else:
                # The agent-host messages the agent when a human decides, so no polling.
                msg = (
                    f"requested: {rid} (status: {body['status']}). A human must approve this "
                    f"in this conversation. You will get a message when they approve or deny "
                    f"it, so don't poll: carry on or end your turn. Once approved, use "
                    f"`aws --profile {args.profile} …`; `scooter-aws status {rid}` shows where "
                    f"it stands. Do NOT create another request for this account while this one "
                    f"is pending."
                )
                if conv_url:
                    msg += f"\nShare this link so a human can approve: {conv_url}"
                print(msg)
            return 0
        sys.stderr.write(f"request failed ({status}): {json.dumps(body.get('detail', body))}\n")
        return 1

    return 2


# --- helpers (shared) ----------------------------------------------------
def render_aws_config(account_registry: dict[str, dict], *, helper_path: str = "scooter-aws-credentials") -> str:
    """Render ~/.aws/config with one [profile <name>] per enabled account, each using `credential_process = {helper_path} --profile <name>`."""
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
