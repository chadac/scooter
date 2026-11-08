"""What the agent and the approver see of an object: noise stripped, Secret values hidden.

Redaction is here, on every response, so no tool can hand the agent a Secret's values
except k8s_secret_reveal after its approval.
"""

from __future__ import annotations

import base64
import binascii
import copy
import difflib
import hashlib
from typing import Any

import yaml

LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration"
# Server-set fields that only add noise to a diff.
_VOLATILE = ("managedFields", "resourceVersion", "uid", "generation", "creationTimestamp", "selfLink")


def _secret_value(value: Any, *, encoded: bool, hashed: bool) -> str:
    raw = str(value or "").encode()
    if encoded:
        try:
            raw = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            pass
    out = f"<redacted: {len(raw)} bytes"
    # Digest shows which keys change without revealing values.
    return out + (f", sha256 {hashlib.sha256(raw).hexdigest()[:8]}>" if hashed else ">")


def redact(obj: dict, *, kind: str = "", hashed: bool = False) -> dict:
    """A copy with Secret values replaced by their lengths; other kinds pass through."""
    if (kind or obj.get("kind")) != "Secret":
        return obj
    out = copy.deepcopy(obj)
    for field, encoded in (("data", True), ("stringData", False)):
        if isinstance(out.get(field), dict):
            out[field] = {k: _secret_value(v, encoded=encoded, hashed=hashed) for k, v in out[field].items()}
    annotations = (out.get("metadata") or {}).get("annotations") or {}
    if LAST_APPLIED in annotations:
        annotations[LAST_APPLIED] = "<redacted>"
    return out


def clean(obj: dict, *, kind: str = "", for_diff: bool = False) -> dict:
    """managedFields gone and Secrets redacted; for a diff, server-set fields and status too."""
    out = copy.deepcopy(obj)
    meta = out.get("metadata") or {}
    meta.pop("managedFields", None)
    if for_diff:
        for k in _VOLATILE:
            meta.pop(k, None)
        (meta.get("annotations") or {}).pop(LAST_APPLIED, None)
        if meta.get("annotations") == {}:
            meta.pop("annotations")
        out.pop("status", None)
    return redact(out, kind=kind, hashed=for_diff)


def to_yaml(obj: Any) -> str:
    return yaml.safe_dump(obj, sort_keys=False, default_flow_style=False)


def describe(obj: dict) -> str:
    """`Kind namespace/name`, as cards and results name an object."""
    meta = obj.get("metadata") or {}
    where = f"{meta['namespace']}/" if meta.get("namespace") else ""
    return f"{obj.get('kind', '?')} {where}{meta.get('name', '?')}"


def diff(before: dict | None, after: dict, *, kind: str = "") -> str:
    """A unified diff of the cleaned objects; '' when nothing changes."""
    a = to_yaml(clean(before, kind=kind, for_diff=True)).splitlines(keepends=True) if before else []
    b = to_yaml(clean(after, kind=kind, for_diff=True)).splitlines(keepends=True)
    name = describe(after)
    return "".join(difflib.unified_diff(a, b, fromfile=f"{name} (live)" if before else "/dev/null",
                                        tofile=f"{name} (applied)"))


def event(e: dict) -> dict:
    involved = e.get("involvedObject") or {}
    return {"last_seen": e.get("lastTimestamp") or e.get("eventTime"), "type": e.get("type"),
            "reason": e.get("reason"), "count": e.get("count"),
            "object": f"{involved.get('kind')}/{involved.get('name')}", "message": e.get("message")}


def summary(obj: dict, kind: str) -> dict:
    """One row of k8s_list: name, age and the status a person scans for."""
    meta = obj.get("metadata") or {}
    row: dict[str, Any] = {"name": meta.get("name")}
    if meta.get("namespace"):
        row["namespace"] = meta["namespace"]
    row["created"] = meta.get("creationTimestamp") or ""
    spec, status = obj.get("spec") or {}, obj.get("status") or {}
    if kind == "Pod":
        statuses = status.get("containerStatuses") or []
        row["phase"] = status.get("phase")
        row["ready"] = f"{sum(1 for c in statuses if c.get('ready'))}/{len(statuses)}"
        row["restarts"] = sum(c.get("restartCount") or 0 for c in statuses)
        row["node"] = spec.get("nodeName")
    elif "replicas" in spec:
        row["replicas"] = spec.get("replicas")
        row["ready"] = status.get("readyReplicas") or 0
    elif kind == "Secret":
        row["type"] = obj.get("type")
        row["keys"] = sorted((obj.get("data") or {}).keys())
    elif kind == "Event":
        row.update(event(obj))
    elif status.get("phase"):
        row["phase"] = status["phase"]
    return row
