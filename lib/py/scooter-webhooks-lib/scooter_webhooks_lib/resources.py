"""Canonical shapes for (source, resource_type, resource_id) — the ONE place that
knows ("pull_request", "o/r#7") and ("pr", "<html_url>") are the same resource.

Nothing here rewrites conversation_map: its resource_id is matched EXACTLY to route an
incoming webhook, so we normalise what we WRITE to resource_links and match every known
shape on READ. Why: PR #571.

The MECHANISM is here; the per-provider knowledge is REGISTERED. This module used to
hold every provider's URL regex and an `if source == "github" / "gitlab" / "jira"`
chain, so adding a provider meant editing shared surface — the same shape the provider,
handler and identity registries already replaced. Each provider now contributes its own
shapes and a provider Scooter doesn't ship simply has none, which degrades to
exact-match: an id resolves to itself and to nothing else. Why: PR #576.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

# (resource_type, resource_id) -> every id form naming that resource, caller's FIRST.
IdVariants = Callable[[str, str], list[str]]


@dataclass(frozen=True)
class ResourceShapes:
    """One provider's resource-identity knowledge.

    ``type_aliases`` maps every spelling to the canonical LONG form — long because it
    is what conversation_map already holds and what the UI renders ("pull request",
    not "pr"). ``id_variants`` is optional: a provider whose ids have exactly one
    spelling (slack) needs only aliases.
    """

    type_aliases: dict[str, str] = field(default_factory=dict)
    id_variants: IdVariants | None = None


_shapes: dict[str, ResourceShapes] = {}


def register_resource_shapes(source: str, shapes: ResourceShapes) -> None:
    """Register one provider's shapes. Re-registering REPLACES, so a contrib can
    override an in-tree provider without the app knowing."""
    _shapes[source] = shapes


def registered_sources() -> list[str]:
    """Which sources contribute shapes, for diagnostics."""
    return sorted(_shapes)


def canonical_resource_type(source: str, resource_type: str) -> str:
    """The long-form type for this source; unknown types pass through unchanged."""
    shapes = _shapes.get(source)
    if shapes is None:
        return resource_type
    return shapes.type_aliases.get(resource_type.lower(), resource_type)


def _type_variants(source: str, resource_type: str) -> list[str]:
    """Every spelling of this type, the caller's own first."""
    shapes = _shapes.get(source)
    if shapes is None:
        return [resource_type]
    canonical = canonical_resource_type(source, resource_type)
    others = [
        alias
        for alias, target in shapes.type_aliases.items()
        if target == canonical and alias != resource_type
    ]
    return [resource_type, *others]


def resource_id_variants(source: str, resource_type: str, resource_id: str) -> list[str]:
    """Every id form that names this resource, the caller's own first. An id that
    parses as nothing known yields only itself — no invented URL, so an unlinked
    resource still resolves to nothing rather than to someone else's."""
    shapes = _shapes.get(source)
    if shapes is None or shapes.id_variants is None:
        return [resource_id]
    return shapes.id_variants(resource_type, resource_id)


def link_variants(source: str, resource_type: str, resource_id: str) -> list[tuple[str, str]]:
    """(resource_type, resource_id) pairs to try, the caller's own shape FIRST so a
    row written in this service's terms still matches without a rewrite."""
    out: list[tuple[str, str]] = []
    for rid in resource_id_variants(source, resource_type, resource_id):
        for rtype in _type_variants(source, resource_type):
            pair = (rtype, rid)
            if pair not in out:
                out.append(pair)
    return out


def canonical_link(source: str, resource_type: str, resource_id: str) -> tuple[str, str]:
    """The shape to STORE in resource_links: long-form type, and the URL form when
    one is derivable (what the agent-host writes, and so what the table already
    mostly holds)."""
    rtype = canonical_resource_type(source, resource_type)
    rid = resource_id
    for candidate in resource_id_variants(source, rtype, resource_id):
        if candidate.startswith("http://") or candidate.startswith("https://"):
            rid = candidate
            break
    return rtype, rid
