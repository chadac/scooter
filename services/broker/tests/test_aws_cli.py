"""Sandbox AWS tools — render_aws_config (the pure, profile-aware piece).

RED-first against the boilerplate. The credential_process helper + request CLI
(which need a live broker + SA token) are exercised in the cluster e2e; here we
pin the ~/.aws/config generation that makes profiles work.
"""

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
