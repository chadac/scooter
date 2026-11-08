"""Reads answer at once and never show a Secret's values."""

from __future__ import annotations

import json

import yaml

from scooter_contrib_k8s.mcp_tools import (
    k8s_api_resources, k8s_apply, k8s_clusters, k8s_describe, k8s_get, k8s_list, k8s_logs,
)

from conftest import ctx


async def test_get_strips_managed_fields(configured):
    r = await k8s_get("deploy", "web", cluster="home")
    assert not r.is_error, r.text
    obj = yaml.safe_load(r.text)
    assert obj["spec"]["replicas"] == 2 and "managedFields" not in obj["metadata"]


async def test_get_secret_shows_lengths_only(configured):
    r = await k8s_get("secret", "db", cluster="home")
    assert not r.is_error, r.text
    assert "aHVudGVyMg" not in r.text and "hunter2" not in r.text and "YWRtaW4" not in r.text
    assert yaml.safe_load(r.text)["data"] == {"password": "<redacted: 7 bytes>", "user": "<redacted: 5 bytes>"}


async def test_list_secrets_lists_keys(configured):
    r = await k8s_list("secrets", cluster="home")
    assert json.loads(r.text) == [{"name": "db", "namespace": "default", "created": "", "type": "Opaque",
                                   "keys": ["password", "user"]}]
    assert "aHVudGVyMg" not in r.text


async def test_list_summarises_deployments(configured):
    rows = json.loads((await k8s_list("deploy", cluster="home")).text)
    assert rows[0]["replicas"] == 2 and rows[0]["ready"] == 2


async def test_describe_and_logs(configured):
    r = await k8s_describe("secret", "db", cluster="home")
    assert not r.is_error and "aHVudGVyMg" not in r.text
    assert (await k8s_logs("web-1", cluster="home")).text.startswith("line 1")


async def test_errors_name_the_problem(configured):
    assert "configured: home, prod, ro" in (await k8s_get("pod", "x", cluster="nope")).text
    assert "name a cluster" in (await k8s_get("pod", "x")).text
    missing = await k8s_get("pod", "nope", cluster="home")
    assert missing.is_error and "404" in missing.text


async def test_clusters_and_resources(configured):
    clusters = {c["cluster"]: c for c in json.loads((await k8s_clusters()).text)}
    assert clusters["prod"]["approvers"] == ["admin@example.com"] and clusters["ro"]["read_only"]
    kinds = json.loads((await k8s_api_resources(cluster="home", search="deploy")).text)
    assert [k["kind"] for k in kinds] == ["Deployment"]


async def test_unconfigured_tools_answer_with_an_error():
    r = await k8s_apply("", ctx=ctx())
    assert r.is_error and "not configured" in r.text
