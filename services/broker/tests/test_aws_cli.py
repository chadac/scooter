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
