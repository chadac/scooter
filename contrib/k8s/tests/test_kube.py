"""Impersonation headers, and reading exec's exit status."""

from __future__ import annotations

import json

from scooter_contrib_k8s.kube import Actor, Kube, _exit_code


class NoAuth:
    ttl = None

    async def configuration(self):
        raise AssertionError("not built")


def test_impersonation_headers_name_the_user_and_extras():
    kube = Kube(NoAuth(), "scooter-k8s")
    assert kube._headers(Actor("c-1", "u-7")) == {
        "Impersonate-User": "scooter-k8s",
        "Impersonate-Extra-scooter-conversation": "c-1",
        "Impersonate-Extra-scooter-approver": "u-7",
    }
    assert "Impersonate-Extra-scooter-approver" not in kube._headers(Actor("c-1"))
    assert kube._headers(None) == {}


def test_no_impersonate_user_means_the_brokers_identity():
    assert Kube(NoAuth())._headers(Actor("c-1", "u-7")) == {}


def test_exit_code_from_the_status_channel():
    failed = {"status": "Failure", "reason": "NonZeroExitCode",
              "details": {"causes": [{"reason": "ExitCode", "message": "3"}]}}
    assert _exit_code(json.dumps({"status": "Success"}).encode()) == 0
    assert _exit_code(json.dumps(failed).encode()) == 3
    assert _exit_code(None) is None and _exit_code(b"not json") is None
