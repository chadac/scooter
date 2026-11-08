"""Secret values never leave the broker through a read, and diffs hide them too."""

from __future__ import annotations

import pytest

from scooter_contrib_k8s import objects
from scooter_contrib_k8s.auth import auth_for, refuse_plugins
from scooter_contrib_k8s.config import parse_clusters
from scooter_contrib_k8s.kube import K8sError, Resource, resolve

RESOURCES = [
    Resource("v1", "Event", "events", True, ("ev",)),
    Resource("events.k8s.io/v1", "Event", "events", True, ("ev",)),
    Resource("apps/v1", "Deployment", "deployments", True, ("deploy",)),
    Resource("autoscaling/v1", "HorizontalPodAutoscaler", "horizontalpodautoscalers", True, ("hpa",), preferred=False),
    Resource("autoscaling/v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers", True, ("hpa",)),
]

SECRET = {
    "apiVersion": "v1", "kind": "Secret",
    "metadata": {"name": "db", "managedFields": [{}],
                 "annotations": {objects.LAST_APPLIED: '{"data":{"password":"aHVudGVyMg=="}}'}},
    "data": {"password": "aHVudGVyMg=="}, "stringData": {"token": "abc"},
}


def test_clean_redacts_every_secret_value():
    out = objects.clean(SECRET)
    text = objects.to_yaml(out)
    assert "aHVudGVyMg" not in text and "hunter2" not in text and "abc" not in text
    assert out["data"] == {"password": "<redacted: 7 bytes>"}
    assert out["stringData"] == {"token": "<redacted: 3 bytes>"}
    assert "managedFields" not in out["metadata"]
    assert SECRET["data"]["password"] == "aHVudGVyMg=="


def test_redact_by_resource_kind_when_items_lack_one():
    assert objects.redact({"data": {"k": "dg=="}}, kind="Secret")["data"]["k"].startswith("<redacted")


def test_diff_shows_which_secret_keys_change_but_not_values():
    after = {**SECRET, "data": {"password": "bmV3"}}
    d = objects.diff(SECRET, after)
    assert "password" in d and "sha256" in d
    assert "bmV3" not in d and "aHVudGVyMg" not in d


def test_diff_is_empty_when_only_server_fields_change():
    a = {"kind": "ConfigMap", "metadata": {"name": "c", "resourceVersion": "1"}, "data": {"a": "1"}}
    b = {"kind": "ConfigMap", "metadata": {"name": "c", "resourceVersion": "2"}, "data": {"a": "1"}}
    assert objects.diff(a, b) == ""


def test_resolve_kinds_like_kubectl():
    assert resolve(RESOURCES, "deploy").api_version == "apps/v1"
    assert resolve(RESOURCES, "Deployments").kind == "Deployment"
    # Core wins over events.k8s.io.
    assert resolve(RESOURCES, "events").api_version == "v1"
    assert resolve(RESOURCES, "events", "events.k8s.io/v1").api_version == "events.k8s.io/v1"
    assert resolve(RESOURCES, "hpa").api_version == "autoscaling/v2"
    assert resolve(RESOURCES, "hpa", "autoscaling/v1").api_version == "autoscaling/v1"
    with pytest.raises(K8sError, match="no resource kind"):
        resolve(RESOURCES, "widgets")


def test_kubeconfig_with_an_exec_plugin_is_refused(monkeypatch):
    with pytest.raises(ValueError, match="exec"):
        refuse_plugins({"users": [{"name": "eks", "user": {"exec": {"command": "aws"}}}]})
    monkeypatch.setenv("K8S_KUBECONFIG_PROD", "users:\n- name: u\n  user:\n    auth-provider: {name: gcp}\n")
    with pytest.raises(ValueError, match="auth-provider"):
        auth_for({"type": "kubeconfig", "env": "K8S_KUBECONFIG_PROD"})
    with pytest.raises(ValueError, match="empty"):
        auth_for({"type": "kubeconfig", "env": "K8S_KUBECONFIG_NONE"})
    with pytest.raises(ValueError, match="unknown"):
        auth_for({"type": "eksIam"})


def test_parse_clusters():
    got = parse_clusters('{"prod": {"auth": {"type": "inCluster"}, "approvers": ["a@x"], '
                         '"grants": {"enable": true, "max_minutes": 15}}}')
    c = got["prod"]
    assert (c.approvers, c.grants_enabled, c.grant_max_minutes, c.default_namespace) == (("a@x",), True, 15, "default")
    with pytest.raises(ValueError):
        parse_clusters('{"x": {}}')
