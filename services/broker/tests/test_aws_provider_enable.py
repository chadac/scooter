"""Finding #3 (HIGH): a configured-but-broken aws_accounts_file must FAIL FAST
when aws_enabled=True, not silently disable the AWS provider.

Returning {} on a read error makes `enabled = aws_enabled and bool(registry)`
False even when the operator set aws_enabled=True — the broker boots "healthy"
and every credential request 503s, indistinguishable from a deliberately-off
provider. So: explicitly-enabled + unreadable file -> raise (fail fast).
"""

from __future__ import annotations

import json

import pytest

from broker.providers import aws as aws_provider


def _set_settings(monkeypatch, *, enabled: bool, path: str):
    monkeypatch.setattr(aws_provider.settings, "aws_enabled", enabled, raising=False)
    monkeypatch.setattr(aws_provider.settings, "aws_accounts_file", path, raising=False)


def test_unset_file_yields_empty_registry(monkeypatch):
    _set_settings(monkeypatch, enabled=True, path="")
    assert aws_provider._load_registry() == {}


def test_enabled_but_unreadable_file_raises(monkeypatch, tmp_path):
    """aws_enabled=True + a path that can't be opened -> raise (don't mask)."""
    _set_settings(monkeypatch, enabled=True, path=str(tmp_path / "does-not-exist.json"))
    with pytest.raises(Exception):
        aws_provider._load_registry()


def test_enabled_but_malformed_json_raises(monkeypatch, tmp_path):
    bad = tmp_path / "accounts.json"
    bad.write_text("{ this is not valid json", encoding="utf-8")
    _set_settings(monkeypatch, enabled=True, path=str(bad))
    with pytest.raises(Exception):
        aws_provider._load_registry()


def test_disabled_with_broken_file_degrades_quietly(monkeypatch, tmp_path):
    """aws_enabled=False: a broken file is fine to ignore (provider stays off)."""
    _set_settings(monkeypatch, enabled=False, path=str(tmp_path / "missing.json"))
    assert aws_provider._load_registry() == {}


def test_enabled_with_valid_file_loads(monkeypatch, tmp_path):
    good = tmp_path / "accounts.json"
    good.write_text(json.dumps({"dev": {"approvers": ["alice@x.io"]}}), encoding="utf-8")
    _set_settings(monkeypatch, enabled=True, path=str(good))
    assert aws_provider._load_registry() == {"dev": {"approvers": ["alice@x.io"]}}
