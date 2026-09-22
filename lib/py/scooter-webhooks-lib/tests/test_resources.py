"""Resource shapes are a REGISTRY: the mechanism is the lib's, the knowledge isn't.

The provider regexes this file used to test now live with their providers (the app
today, their contribs as they migrate), so what's left to prove here is the part
that stays: expansion order, and what happens for a source nobody registered.
Why: PR #576.
"""

from __future__ import annotations

import pytest

from scooter_webhooks_lib import resources
from scooter_webhooks_lib.resources import (
    ResourceShapes,
    canonical_link,
    canonical_resource_type,
    link_variants,
    register_resource_shapes,
    resource_id_variants,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    saved = dict(resources._shapes)
    resources._shapes.clear()
    yield
    resources._shapes.clear()
    resources._shapes.update(saved)


def _acme(resource_type: str, resource_id: str) -> list[str]:
    if resource_id.startswith("https://acme.test/"):
        return [resource_id, resource_id.rsplit("/", 1)[-1]]
    return [resource_id, f"https://acme.test/{resource_id}"]


def _register_acme() -> None:
    register_resource_shapes(
        "acme",
        ResourceShapes(
            type_aliases={"tkt": "ticket", "ticket": "ticket"},
            id_variants=_acme,
        ),
    )


# --- an UNREGISTERED source: exact match, and nothing invented ------------------


def test_an_unregistered_source_resolves_only_to_itself():
    # A deployment that doesn't ship gitlab has no gitlab shapes. That must degrade to
    # exact match — the pre-#571 behavior — not to a guess.
    assert resource_id_variants("gitlab", "mr", "acme/web!7") == ["acme/web!7"]
    assert link_variants("gitlab", "mr", "acme/web!7") == [("mr", "acme/web!7")]
    assert canonical_resource_type("gitlab", "mr") == "mr"
    assert canonical_link("gitlab", "mr", "acme/web!7") == ("mr", "acme/web!7")


def test_a_source_with_aliases_but_no_id_variants_still_expands_types():
    # Slack's shape: one id spelling, several type spellings.
    register_resource_shapes(
        "chat", ResourceShapes(type_aliases={"message": "thread", "thread": "thread"})
    )
    assert canonical_resource_type("chat", "message") == "thread"
    assert link_variants("chat", "message", "C1/17.5") == [("message", "C1/17.5"), ("thread", "C1/17.5")]


# --- expansion order: the caller's own shape first -------------------------------


def test_the_callers_own_shape_is_tried_first():
    # A row written in this service's own terms must match without a rewrite, so the
    # caller's spelling leads and the alternatives follow.
    _register_acme()
    assert link_variants("acme", "tkt", "A-1")[0] == ("tkt", "A-1")
    assert link_variants("acme", "ticket", "A-1")[0] == ("ticket", "A-1")


def test_variants_do_not_repeat():
    _register_acme()
    pairs = link_variants("acme", "tkt", "A-1")
    assert len(pairs) == len(set(pairs))


# --- canonical_link: long type, URL id when derivable ----------------------------


def test_canonical_link_stores_the_long_type_and_the_url():
    _register_acme()
    assert canonical_link("acme", "tkt", "A-1") == ("ticket", "https://acme.test/A-1")


def test_canonical_link_keeps_an_id_it_cannot_widen():
    register_resource_shapes("acme", ResourceShapes(type_aliases={"tkt": "ticket"}))
    assert canonical_link("acme", "tkt", "A-1") == ("ticket", "A-1")


# --- a contrib can override an in-tree provider ----------------------------------


def test_re_registering_replaces():
    _register_acme()
    register_resource_shapes("acme", ResourceShapes(type_aliases={"tkt": "issue"}))
    assert canonical_resource_type("acme", "tkt") == "issue"
    assert resource_id_variants("acme", "tkt", "A-1") == ["A-1"]
