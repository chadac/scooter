"""Tier 1 — the PURE module-level helpers in k8s.py (no cluster). These are the
version-key + naming correctness points the pool hinges on."""

from warm_store_controller.k8s import _tag_of, _tag_slug


# --- _tag_of: must agree with the kubenix `lib.last (splitString ":" ...)` split ---

def test_tag_of_simple():
    assert _tag_of("agent-sandbox-os:latest") == "latest"


def test_tag_of_registry_with_port():
    # A registry :port must NOT be mistaken for the tag (the port segment has a '/').
    assert _tag_of("localhost:5000/agent-sandbox-os:scooter-git-abc123") == "scooter-git-abc123"


def test_tag_of_registry_port_no_tag():
    # ref ending at the repo (no tag) → "" (won't match any warmed PVC).
    assert _tag_of("localhost:5000/agent-sandbox-os") == ""


def test_tag_of_no_tag():
    assert _tag_of("agent-sandbox-os") == ""


def test_tag_of_digest_stripped():
    # A digest is not a tag; strip @sha256:... first.
    assert _tag_of("agent-sandbox-os:latest@sha256:deadbeef") == "latest"


def test_tag_of_empty():
    assert _tag_of("") == ""


# --- _tag_slug: DNS-1123-safe PVC/Job name fragment ---

def test_tag_slug_lowercases_and_sanitizes():
    assert _tag_slug("scooter-git-ABC123") == "scooter-git-abc123"


def test_tag_slug_collapses_bad_chars():
    assert _tag_slug("v1.2_beta") == "v1-2-beta"


def test_tag_slug_trims_and_bounds():
    s = _tag_slug("-" * 3 + "x" * 60)
    assert not s.startswith("-") and not s.endswith("-")
    assert len(s) <= 40


def test_tag_slug_empty_is_untagged():
    assert _tag_slug("") == "untagged"
    assert _tag_slug("___") == "untagged"
