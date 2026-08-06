"""Tier 1 — the warm /nix/store PVC pool (skeleton). Fakes k8s (CoreV1 PVCs +
BatchV1 Jobs), like test_sandbox_k8s.py monkeypatches `_apis`. No cluster.

The pool keys PVCs by SANDBOX IMAGE CONTENT TAG (== the overlay lower identity; proven
by the round-trip spike to need no mount-time fixup) via labels:
  scooter.warm-store/image-tag=<tag>
  scooter.warm-store/state=ready|claimed
A ready PVC is only ever produced AFTER its warm Job completes (RWO single-attach: the
warm Job and a claimant must never hold the volume at once).
"""

from __future__ import annotations

import pytest

import broker.sandbox.warmpool as wp
from broker.sandbox.warmpool import WarmPool, _job_name
from broker.sandbox.manifest import DeployConfig

TAG = "vyk7v5cwsfl6"
STATE = "scooter.warm-store/state"
IMGTAG = "scooter.warm-store/image-tag"


class _ApiExc(Exception):
    def __init__(self, status):
        self.status = status


class _FakeK8s:
    """In-memory PVCs + Jobs with label semantics. One object models CoreV1 (PVCs) +
    BatchV1 (Jobs) for the pool's needs."""

    def __init__(self):
        self.pvcs: dict[str, dict] = {}   # name -> {labels, ...}
        self.jobs: dict[str, dict] = {}   # name -> {succeeded: bool, ...}

    # --- CoreV1: PVCs ---
    def create_namespaced_persistent_volume_claim(self, namespace, body):
        name = body["metadata"]["name"]
        self.pvcs[name] = {"labels": dict(body["metadata"].get("labels", {})), "body": body}

    def list_namespaced_persistent_volume_claim(self, namespace, label_selector=None):
        items = []
        for name, p in self.pvcs.items():
            if label_selector and not _match(p["labels"], label_selector):
                continue
            items.append(_Obj(name, p["labels"]))
        return _Obj(None, None, items=items)

    def patch_namespaced_persistent_volume_claim(self, name, namespace, body):
        # Support the label-swap claim guard: only applies if the PVC still matches the
        # caller's expected pre-state (modeled by the pool doing read-then-swap).
        self.pvcs[name]["labels"].update(body["metadata"]["labels"])

    # --- BatchV1: Jobs ---
    def create_namespaced_job(self, namespace, body):
        self.jobs[body["metadata"]["name"]] = {"succeeded": False, "body": body}

    def read_namespaced_job(self, name, namespace):
        j = self.jobs[name]
        return _Obj(name, None, succeeded=1 if j["succeeded"] else None)


def _match(labels, selector):
    for pair in selector.split(","):
        k, _, v = pair.partition("=")
        if labels.get(k) != v:
            return False
    return True


class _Obj:
    """Minimal stand-in for a k8s client object (attr access + .metadata.labels)."""

    def __init__(self, name, labels, items=None, succeeded=None):
        self.metadata = _Meta(name, labels)
        self.items = items or []
        self.status = _Obj.__new__(_Obj) if succeeded is None else None
        if succeeded is not None:
            self.status = type("S", (), {"succeeded": succeeded})()


class _Meta:
    def __init__(self, name, labels):
        self.name = name
        self.labels = labels or {}


@pytest.fixture
def pool(monkeypatch):
    fake = _FakeK8s()
    monkeypatch.setattr(wp.client, "ApiException", _ApiExc, raising=False)
    monkeypatch.setattr(wp, "_apis", lambda: (fake, fake))  # (core, batch) both -> fake
    p = WarmPool(DeployConfig(namespace="agent-sandbox", sandbox_image=f"img:{TAG}"))
    p._fake = fake  # test handle
    return p


# --- claim -----------------------------------------------------------------

def test_claim_empty_pool_returns_none(pool):
    assert pool.claim(TAG) is None


def test_warm_then_claim_roundtrip(pool):
    # warm() creates a PVC + Job labeled with the tag; before Job success it is NOT ready.
    name = pool.warm(TAG)
    assert pool._fake.pvcs[name]["labels"][IMGTAG] == TAG
    assert pool._fake.pvcs[name]["labels"][STATE] != "ready"
    assert _job_name(name) in pool._fake.jobs                       # a warm Job was launched
    assert pool.claim(TAG) is None                       # not ready until the Job wins

    # Job completes -> mark_ready flips it; now claim returns it as claimed.
    pool._fake.jobs[_job_name(name)]["succeeded"] = True
    pool.reconcile()                                     # observes Job success -> ready
    assert pool._fake.pvcs[name]["labels"][STATE] == "ready"

    claimed = pool.claim(TAG)
    assert claimed == name
    assert pool._fake.pvcs[name]["labels"][STATE] == "claimed"


def test_claim_is_exclusive(pool):
    name = pool.warm(TAG)
    pool._fake.jobs[_job_name(name)]["succeeded"] = True
    pool.reconcile()
    first = pool.claim(TAG)
    second = pool.claim(TAG)                              # pool now empty of ready
    assert first == name
    assert second is None                                # no double hand-out


def test_return_flips_claimed_to_ready(pool):
    name = pool.warm(TAG)
    pool._fake.jobs[_job_name(name)]["succeeded"] = True
    pool.reconcile()
    pool.claim(TAG)
    pool.return_(name)
    assert pool._fake.pvcs[name]["labels"][STATE] == "ready"


def test_claim_ignores_other_tags(pool):
    name = pool.warm(TAG)
    pool._fake.jobs[_job_name(name)]["succeeded"] = True
    pool.reconcile()
    assert pool.claim("different-tag-000") is None       # tag mismatch -> no claim


# --- warm Job manifest -----------------------------------------------------

def test_warm_job_manifest_mounts_pvc_at_upper_and_uses_image(pool):
    m = pool.warm_job_manifest(pvc_name="warm-abc", image_tag=TAG)
    spec = m["spec"]["template"]["spec"]
    # one-shot Job semantics
    assert spec["restartPolicy"] in ("Never", "OnFailure")
    # the sandbox image (so the lower == the image these warmed paths reference)
    img = spec["containers"][0]["image"]
    assert img.endswith(f":{TAG}") or TAG in img
    # the PVC is mounted where the overlay expects its writable upper
    vols = {v["name"]: v for v in spec["volumes"]}
    assert any(v.get("persistentVolumeClaim", {}).get("claimName") == "warm-abc" for v in vols.values())
