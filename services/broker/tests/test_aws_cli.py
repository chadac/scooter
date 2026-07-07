"""Sandbox AWS tools — render_aws_config (the pure, profile-aware piece).

RED-first against the boilerplate. The credential_process helper + request CLI
(which need a live broker + SA token) are exercised in the cluster e2e; here we
pin the ~/.aws/config generation that makes profiles work.
"""

import json

import broker.aws.cli as cli
from broker.aws.cli import render_aws_config

REGISTRY = {
    "dev": {"account_id": "123", "region": "us-east-1", "enabled": True},
    "prod": {"account_id": "456", "region": "us-west-2", "enabled": True},
    "off": {"account_id": "789", "enabled": False},
}


def test_render_emits_a_profile_per_enabled_account():
    cfg = render_aws_config(REGISTRY)
    assert "[profile dev]" in cfg
    assert "[profile prod]" in cfg
    # Disabled accounts are not offered as profiles.
    assert "[profile off]" not in cfg


def test_render_wires_credential_process_per_profile():
    cfg = render_aws_config(REGISTRY, helper_path="/usr/bin/scooter-aws-credentials")
    assert "credential_process = /usr/bin/scooter-aws-credentials --profile dev" in cfg
    assert "credential_process = /usr/bin/scooter-aws-credentials --profile prod" in cfg


def test_render_sets_region_when_present():
    cfg = render_aws_config(REGISTRY)
    # The prod profile carries its account's region.
    assert "us-west-2" in cfg


# --- credential_process helper ------------------------------------------
def test_credentials_helper_emits_credential_process_json(monkeypatch, capsys):
    """When an active grant exists, print the AWS credential_process JSON."""
    def fake_call(method, path, body=None):
        if path.startswith("requests"):
            return 200, {"requests": [{"request_id": "r1", "status": "active", "target_account": "dev"}]}
        return 200, {"credentials": {
            "access_key_id": "AKIA", "secret_access_key": "sec", "session_token": "tok",
            "expires_at": "2030-01-01T00:00:00Z",
        }}
    monkeypatch.setattr(cli, "_call", fake_call)
    rc = cli.credentials_main(["--profile", "dev"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["Version"] == 1
    assert out["AccessKeyId"] == "AKIA" and out["SessionToken"] == "tok"
    assert out["Expiration"] == "2030-01-01T00:00:00Z"


def test_credentials_helper_fails_closed_with_actionable_error(monkeypatch, capsys):
    """No active grant -> non-zero + a verbose 'how to request' message (fail closed)."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (200, {"requests": []}))
    rc = cli.credentials_main(["--profile", "dev"])
    err = capsys.readouterr().err
    assert rc == 1
    assert "not granted" in err and "scooter-aws request --profile dev" in err


def test_request_sends_conversation_url_from_env(monkeypatch, tmp_path, capsys):
    """`scooter-aws request` attaches CONVERSATION_URL (the agent's own convo link)
    so the approval UI / requester can jump to it; and tells the agent to share it."""
    captured = {}

    def fake_call(method, path, body=None):
        captured["body"] = body
        return 201, {"request_id": "abc123", "status": "pending"}

    monkeypatch.setattr(cli, "_call", fake_call)
    monkeypatch.setenv("CONVERSATION_URL", "https://ui/?thread=conv-1")
    pol = tmp_path / "p.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}')

    rc = cli.cli_main(["request", "--profile", "dev", "--policy", str(pol), "--justification", "read"])
    assert rc == 0
    assert captured["body"]["conversation_url"] == "https://ui/?thread=conv-1"
    out = capsys.readouterr().out
    assert "https://ui/?thread=conv-1" in out  # the agent is told to share the link


def test_pick_active_request_takes_newest_nonexpired_not_the_first_zombie():
    """The credential helper must NOT take the FIRST (oldest) active request — a
    zombie whose STS creds lapsed hours ago (teardown stuck) sits at the front of the
    oldest-first list and would hand the SDK an already-expired token. Pick the
    NEWEST active request that isn't past its expiry."""
    from broker.aws.cli import _pick_active_request

    reqs = [
        # oldest, ALREADY EXPIRED (the zombie the old code picked)
        {"request_id": "old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T10:00:00Z", "expires_at": "2026-07-07T11:00:00Z"},
        # newest, still valid
        {"request_id": "new", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T18:00:00Z", "expires_at": "2999-01-01T00:00:00Z"},
    ]
    picked = _pick_active_request(reqs, "prod")
    assert picked is not None and picked["request_id"] == "new"


def test_pick_active_request_ignores_other_accounts_and_nonactive():
    from broker.aws.cli import _pick_active_request

    reqs = [
        {"request_id": "wrong-acct", "status": "active", "target_account": "dev",
         "requested_at": "2026-07-07T19:00:00Z", "expires_at": "2999-01-01T00:00:00Z"},
        {"request_id": "pending", "status": "pending", "target_account": "prod",
         "requested_at": "2026-07-07T19:00:00Z"},
        {"request_id": "ok", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T12:00:00Z", "expires_at": "2999-01-01T00:00:00Z"},
    ]
    picked = _pick_active_request(reqs, "prod")
    assert picked is not None and picked["request_id"] == "ok"


def test_pick_active_request_falls_back_to_newest_when_all_expired():
    """If EVERY active request is past expiry, still return the newest — the broker
    auto-refreshes on status(), so even a lapsed one may re-vend a live token; better
    than 'not granted' when a valid role exists."""
    from broker.aws.cli import _pick_active_request

    reqs = [
        {"request_id": "old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T10:00:00Z", "expires_at": "2026-07-07T11:00:00Z"},
        {"request_id": "less-old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T14:00:00Z", "expires_at": "2026-07-07T15:00:00Z"},
    ]
    picked = _pick_active_request(reqs, "prod")
    assert picked is not None and picked["request_id"] == "less-old"


def test_pick_active_request_none_when_no_active():
    from broker.aws.cli import _pick_active_request
    assert _pick_active_request([], "prod") is None


def test_refresh_posts_to_the_refresh_route(monkeypatch, capsys):
    """`scooter-aws refresh <id>` POSTs /{id}/refresh — the manual escape hatch to
    force a fresh STS token when the cached one has expired within the role TTL."""
    captured = {}

    def fake_call(method, path, body=None):
        captured["method"] = method
        captured["path"] = path
        return 200, {"request_id": "abc123", "credentials": {"access_key_id": "AKIA"}}

    monkeypatch.setattr(cli, "_call", fake_call)
    rc = cli.cli_main(["refresh", "abc123"])
    assert rc == 0
    assert captured["method"] == "POST"
    assert captured["path"] == "abc123/refresh"


def test_request_reports_auto_approval(monkeypatch, tmp_path, capsys):
    """A read-only auto-approved request (status 'active') tells the agent creds
    are ready, not 'waiting for approval'."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (201, {"request_id": "abc123", "status": "active"}))
    monkeypatch.delenv("CONVERSATION_URL", raising=False)
    pol = tmp_path / "p.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}')

    rc = cli.cli_main(["request", "--profile", "dev", "--policy", str(pol), "--justification", "read"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "AUTO-APPROVED" in out and "waiting" not in out.lower()


def test_request_pending_tells_agent_to_poll_status(monkeypatch, tmp_path, capsys):
    """A write request comes back 'pending' — the agent isn't paused or auto-notified,
    so the output MUST tell it to poll `scooter-aws status <id>` (a common failure is
    re-requesting in a loop). Pins the wait-for-approval guidance."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (201, {"request_id": "req-9", "status": "pending"}))
    monkeypatch.delenv("CONVERSATION_URL", raising=False)
    pol = tmp_path / "p.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"*"}]}')

    rc = cli.cli_main(["request", "--profile", "dev", "--policy", str(pol), "--justification", "write"])
    assert rc == 0
    out = capsys.readouterr().out.lower()
    assert "scooter-aws status req-9" in out       # told HOW to poll
    assert "active" in out and "poll" in out         # told WHAT to wait for
    assert "not" in out and "another request" in out  # told not to re-request
