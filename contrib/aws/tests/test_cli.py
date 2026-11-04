"""Sandbox AWS tools: the ~/.aws/config render and the CLI against a faked broker call."""

import json

import scooter_contrib_aws.cli as cli
from scooter_contrib_aws.cli import render_aws_config

REGISTRY = {
    "dev": {"account_id": "123", "region": "us-east-1", "enabled": True},
    "prod": {"account_id": "456", "region": "us-west-2", "enabled": True},
    "off": {"account_id": "789", "enabled": False},
}


def test_render_emits_a_profile_per_enabled_account():
    cfg = render_aws_config(REGISTRY)
    assert "[profile dev]" in cfg
    assert "[profile prod]" in cfg
    assert "[profile off]" not in cfg


def test_render_wires_credential_process_per_profile():
    cfg = render_aws_config(REGISTRY, helper_path="/usr/bin/scooter-aws-credentials")
    assert "credential_process = /usr/bin/scooter-aws-credentials --profile dev" in cfg
    assert "credential_process = /usr/bin/scooter-aws-credentials --profile prod" in cfg


def test_render_sets_region_when_present():
    cfg = render_aws_config(REGISTRY)
    assert "us-west-2" in cfg


# --- credential_process helper ------------------------------------------
def test_credentials_helper_emits_credential_process_json(monkeypatch, capsys):
    """An active grant prints the AWS credential_process JSON."""
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
    """No active grant fails closed with a 'how to request' message."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (200, {"requests": []}))
    rc = cli.credentials_main(["--profile", "dev"])
    err = capsys.readouterr().err
    assert rc == 1
    assert "not granted" in err and "scooter-aws request --profile dev" in err


def test_request_sends_conversation_url_from_env(monkeypatch, tmp_path, capsys):
    """`scooter-aws request` attaches CONVERSATION_URL and tells the agent to share it."""
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
    assert "https://ui/?thread=conv-1" in out


def test_escalate_posts_to_escalate_route_with_parent(monkeypatch, tmp_path, capsys):
    """`scooter-aws escalate <parent_request_id> …` POSTs /aws/escalate with parent_request_id."""
    captured = {}

    def fake_call(method, path, body=None):
        captured["method"], captured["path"], captured["body"] = method, path, body
        return 201, {"request_id": "def456", "status": "pending"}

    monkeypatch.setattr(cli, "_call", fake_call)
    monkeypatch.setenv("CONVERSATION_URL", "https://ui/?thread=conv-1")
    pol = tmp_path / "more.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"*"}]}')

    rc = cli.cli_main(["escalate", "abc123", "--profile", "dev", "--policy", str(pol), "--justification", "need write too"])
    assert rc == 0
    assert captured["method"] == "POST"
    assert captured["path"] == "escalate"
    assert captured["body"]["parent_request_id"] == "abc123"
    assert captured["body"]["target_account"] == "dev"
    assert captured["body"]["justification"] == "need write too"
    assert captured["body"]["conversation_url"] == "https://ui/?thread=conv-1"


def test_escalate_requires_a_policy_or_managed(monkeypatch, capsys):
    """An escalate with no additional scope is refused."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (201, {"request_id": "x", "status": "pending"}))
    with __import__("pytest").raises(SystemExit):
        cli.cli_main(["escalate", "abc123", "--profile", "dev", "--justification", "why"])


def test_pick_active_request_takes_newest_nonexpired_not_the_first_zombie():
    """The newest active request that is not past its expiry wins over an older expired one."""
    from scooter_contrib_aws.cli import _pick_active_request

    reqs = [
        {"request_id": "old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T10:00:00Z", "expires_at": "2026-07-07T11:00:00Z"},
        {"request_id": "new", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T18:00:00Z", "expires_at": "2999-01-01T00:00:00Z"},
    ]
    picked = _pick_active_request(reqs, "prod")
    assert picked is not None and picked["request_id"] == "new"


def test_pick_active_request_ignores_other_accounts_and_nonactive():
    from scooter_contrib_aws.cli import _pick_active_request

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
    """When every active request is past expiry the newest is still returned, since the broker re-vends on status()."""
    from scooter_contrib_aws.cli import _pick_active_request

    reqs = [
        {"request_id": "old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T10:00:00Z", "expires_at": "2026-07-07T11:00:00Z"},
        {"request_id": "less-old", "status": "active", "target_account": "prod",
         "requested_at": "2026-07-07T14:00:00Z", "expires_at": "2026-07-07T15:00:00Z"},
    ]
    picked = _pick_active_request(reqs, "prod")
    assert picked is not None and picked["request_id"] == "less-old"


def test_pick_active_request_none_when_no_active():
    from scooter_contrib_aws.cli import _pick_active_request
    assert _pick_active_request([], "prod") is None


def test_refresh_posts_to_the_refresh_route(monkeypatch, capsys):
    """`scooter-aws refresh <id>` POSTs /{id}/refresh."""
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
    """An auto-approved request tells the agent creds are ready, not to wait."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (201, {"request_id": "abc123", "status": "active"}))
    monkeypatch.delenv("CONVERSATION_URL", raising=False)
    pol = tmp_path / "p.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}')

    rc = cli.cli_main(["request", "--profile", "dev", "--policy", str(pol), "--justification", "read"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "AUTO-APPROVED" in out and "waiting" not in out.lower()


def test_request_pending_tells_agent_it_will_be_messaged(monkeypatch, tmp_path, capsys):
    """A pending request says a message will come, names the status command, and forbids re-requesting."""
    monkeypatch.setattr(cli, "_call", lambda *a, **k: (201, {"request_id": "req-9", "status": "pending"}))
    monkeypatch.delenv("CONVERSATION_URL", raising=False)
    pol = tmp_path / "p.json"
    pol.write_text('{"Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"*"}]}')

    rc = cli.cli_main(["request", "--profile", "dev", "--policy", str(pol), "--justification", "write"])
    assert rc == 0
    out = capsys.readouterr().out.lower()
    assert "scooter-aws status req-9" in out
    assert "you will get a message" in out and "don't poll" in out
    assert "not" in out and "another request" in out
