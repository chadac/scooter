"""Tier 1 — Config.from_env, esp. the pool version-key derivation. The controller must
key the pool by the SAME tag the provisioner claims by, derived from SANDBOX_IMAGE — so a
deploy that rewrites …:latest → …:git-<sha> can't split them (the tag-mismatch bug)."""

import os
from contextlib import contextmanager

from warm_store_controller.config import Config


@contextmanager
def env(**kv):
    old = {k: os.environ.get(k) for k in kv}
    os.environ.update({k: v for k, v in kv.items() if v is not None})
    for k, v in kv.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_tag_derived_from_sandbox_image_ref():
    # The realistic deploy case: SANDBOX_IMAGE carries a registry :port AND a git-sha tag.
    with env(SANDBOX_IMAGE="localhost:5000/agent-sandbox-os:scooter-git-abc123", SANDBOX_IMAGE_TAG=None):
        cfg = Config.from_env()
    assert cfg.current_image_tag == "scooter-git-abc123"
    assert cfg.warm_job_image == "localhost:5000/agent-sandbox-os:scooter-git-abc123"


def test_explicit_tag_override_wins():
    with env(SANDBOX_IMAGE="localhost:5000/agent-sandbox-os:latest", SANDBOX_IMAGE_TAG="pinned"):
        cfg = Config.from_env()
    assert cfg.current_image_tag == "pinned"


def test_no_image_no_tag():
    with env(SANDBOX_IMAGE=None, SANDBOX_IMAGE_TAG=None):
        cfg = Config.from_env()
    assert cfg.current_image_tag == ""
