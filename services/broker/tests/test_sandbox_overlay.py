"""Unit tests for the consumer Sandbox-manifest overlay (sandbox/overlay.py) and its
integration through sandbox_manifest(overlay=...).

The overlay is a recursive PATCH deep-merged onto the generated Sandbox so a deployment
can change the pod manifest WITHOUT patching Scooter. These tests are the SPEC:
  - deep_merge: dicts recurse, scalars replace, lists strategic-merge by `name`.
  - reassert_protected: Scooter's identity/auth/storage fields survive a hostile overlay.
  - parse_overlay: YAML/JSON payload -> dict; empty -> {}; malformed -> OverlayError.
"""

from __future__ import annotations

import pytest

from broker.sandbox.manifest import DeployConfig, sandbox_manifest
from broker.sandbox.overlay import (
    OverlayError,
    apply_overlay,
    deep_merge,
    parse_overlay,
    reassert_protected,
)


def _deploy(**over) -> DeployConfig:
    base = dict(namespace="agent-sandbox", sandbox_image="img:latest")
    base.update(over)
    return DeployConfig(**base)


def _manifest(overlay: dict | None = None) -> dict:
    return sandbox_manifest(
        conversation_id="c1", name="conv-c1", service_account="sandbox-c1",
        deploy=_deploy(), overlay=overlay,
    )


def _container(m: dict) -> dict:
    for c in m["spec"]["podTemplate"]["spec"]["containers"]:
        if c["name"] == "sandbox":
            return c
    raise AssertionError("no sandbox container")


def _env(m: dict) -> dict:
    return {e["name"]: e["value"] for e in _container(m)["env"]}


# --- deep_merge: dicts -------------------------------------------------------


def test_deep_merge_recurses_nested_dicts_and_adds_new_keys():
    base = {"a": {"x": 1, "y": 2}, "keep": True}
    over = {"a": {"y": 20, "z": 30}}
    assert deep_merge(base, over) == {"a": {"x": 1, "y": 20, "z": 30}, "keep": True}


def test_deep_merge_scalar_replaces():
    assert deep_merge({"a": 1}, {"a": 2}) == {"a": 2}


def test_deep_merge_does_not_mutate_inputs():
    base = {"a": {"x": 1}}
    over = {"a": {"y": 2}}
    deep_merge(base, over)
    assert base == {"a": {"x": 1}} and over == {"a": {"y": 2}}


# --- deep_merge: strategic list merge by `name` ------------------------------


def test_list_merge_patches_matching_name_item():
    base = {"env": [{"name": "A", "value": "1"}, {"name": "B", "value": "2"}]}
    over = {"env": [{"name": "B", "value": "20"}]}
    # B is patched in place; A untouched; nothing duplicated.
    assert deep_merge(base, over) == {"env": [{"name": "A", "value": "1"}, {"name": "B", "value": "20"}]}


def test_list_merge_appends_new_named_item():
    base = {"env": [{"name": "A", "value": "1"}]}
    over = {"env": [{"name": "C", "value": "3"}]}
    assert deep_merge(base, over) == {"env": [{"name": "A", "value": "1"}, {"name": "C", "value": "3"}]}


def test_list_merge_appends_unnamed_items():
    # Items with no `name` (e.g. tolerations) can't be matched -> appended.
    base = {"tolerations": [{"key": "a"}]}
    over = {"tolerations": [{"key": "b"}]}
    assert deep_merge(base, over) == {"tolerations": [{"key": "a"}, {"key": "b"}]}


def test_list_merge_is_deep_within_matched_item():
    base = {"c": [{"name": "sandbox", "resources": {"limits": {"memory": "4Gi"}}}]}
    over = {"c": [{"name": "sandbox", "resources": {"limits": {"cpu": "2"}}}]}
    out = deep_merge(base, over)["c"][0]["resources"]["limits"]
    assert out == {"memory": "4Gi", "cpu": "2"}  # deep-merged, not replaced


def test_type_mismatch_dict_onto_list_is_an_error():
    with pytest.raises(OverlayError):
        deep_merge({"a": [1, 2]}, {"a": {"x": 1}})


# --- reassert_protected ------------------------------------------------------


def test_reassert_restores_service_account():
    base = _manifest()
    merged = {**base}
    # Hostile overlay result: SA hijacked.
    merged = deep_merge(base, {"spec": {"podTemplate": {"spec": {"serviceAccountName": "evil"}}}})
    fixed = reassert_protected(base, merged)
    assert fixed["spec"]["podTemplate"]["spec"]["serviceAccountName"] == "sandbox-c1"


def test_reassert_restores_broker_token_volume():
    base = _manifest()
    merged = deep_merge(base, {"spec": {"podTemplate": {"spec": {
        "volumes": [{"name": "broker-token", "configMap": {"name": "evil"}}]}}}})
    fixed = reassert_protected(base, merged)
    bt = next(v for v in fixed["spec"]["podTemplate"]["spec"]["volumes"] if v["name"] == "broker-token")
    assert "projected" in bt and "configMap" not in bt  # original projected SA token restored


def test_reassert_restores_pvc_templates():
    base = _manifest()
    merged = deep_merge(base, {"spec": {"volumeClaimTemplates": []}})  # try to drop PVCs
    fixed = reassert_protected(base, merged)
    assert any(v["metadata"]["name"] == "workspace" for v in fixed["spec"]["volumeClaimTemplates"])


def test_reassert_protects_identity_env_per_variable_but_keeps_added_env():
    base = _manifest()
    merged = deep_merge(base, {"spec": {"podTemplate": {"spec": {"containers": [{
        "name": "sandbox",
        "env": [
            {"name": "CONVERSATION_ID", "value": "spoofed"},  # protected -> restored
            {"name": "MY_TOOL", "value": "ok"},               # added -> kept
        ],
    }]}}}})
    fixed = reassert_protected(base, merged)
    env = _env(fixed)
    assert env["CONVERSATION_ID"] == "c1"  # Scooter's value wins
    assert env["MY_TOOL"] == "ok"          # consumer addition survives


# --- apply_overlay (the public path) + parse ---------------------------------


def test_apply_overlay_empty_is_identity():
    base = _manifest()
    assert apply_overlay(base, {}) == base


def test_parse_overlay_empty_is_empty_dict():
    assert parse_overlay("") == {}
    assert parse_overlay("   \n  ") == {}


def test_parse_overlay_accepts_yaml_and_json():
    assert parse_overlay('{"spec": {"a": 1}}') == {"spec": {"a": 1}}
    assert parse_overlay("spec:\n  a: 1\n") == {"spec": {"a": 1}}


def test_parse_overlay_non_mapping_top_level_is_error():
    with pytest.raises(OverlayError):
        parse_overlay("- 1\n- 2")  # a list, not a mapping


def test_parse_overlay_syntax_error_is_error():
    with pytest.raises(OverlayError):
        parse_overlay("{ this: is: not: valid")


# --- integration through sandbox_manifest(overlay=...) -----------------------


def test_manifest_overlay_adds_nodeselector_and_tolerations():
    overlay = {"spec": {"podTemplate": {"spec": {
        "nodeSelector": {"scooter.io/pool": "sandbox"},
        "tolerations": [{"key": "sandbox", "operator": "Exists", "effect": "NoSchedule"}],
    }}}}
    m = _manifest(overlay)
    ps = m["spec"]["podTemplate"]["spec"]
    assert ps["nodeSelector"] == {"scooter.io/pool": "sandbox"}
    assert ps["tolerations"][0]["key"] == "sandbox"
    # Scooter's structure is intact.
    assert ps["serviceAccountName"] == "sandbox-c1"


def test_manifest_overlay_patches_one_env_var_by_name():
    overlay = {"spec": {"podTemplate": {"spec": {"containers": [{
        "name": "sandbox",
        "env": [{"name": "MY_TOOL_URL", "value": "http://tool.ns.svc:8080"}],
    }]}}}}
    m = _manifest(overlay)
    env = _env(m)
    assert env["MY_TOOL_URL"] == "http://tool.ns.svc:8080"
    assert env["BROKER_URL"].startswith("http://agent-broker")  # base env preserved


def test_manifest_overlay_cannot_break_protected_fields():
    # A hostile overlay that tries to hijack SA + drop the broker token still yields a
    # manifest with Scooter's identity/auth intact.
    overlay = {"spec": {"podTemplate": {"spec": {
        "serviceAccountName": "evil",
        "volumes": [{"name": "broker-token", "configMap": {"name": "evil"}}],
    }}}}
    m = _manifest(overlay)
    ps = m["spec"]["podTemplate"]["spec"]
    assert ps["serviceAccountName"] == "sandbox-c1"
    bt = next(v for v in ps["volumes"] if v["name"] == "broker-token")
    assert "projected" in bt
