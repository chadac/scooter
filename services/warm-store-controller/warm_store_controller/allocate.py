"""PV placement — the pure decision core for handing a sandbox a warm overlay upper.

The controller pre-creates the PVC the sandbox's vct will adopt, pre-bound via `claimRef`.
Placing nothing is valid: the vct then provisions a fresh upper. See PR #403 and
todo/draft/WARM_STORE_PV_OWNERSHIP.md.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

# Ownership marker: ownerReferences cannot own a cluster-scoped PV. PR #403.
PV_FINALIZER = "scooter.io/warm-store"

# Keyed by image tag: the upper is an overlay whose LOWER is that image.
LBL_WARM_STORE = "scooter.io/warm-store"      # image content tag — the version key
ANN_LAST_USED = "scooter.io/last-used"        # rfc3339, for LRU


@dataclass(frozen=True)
class PoolPv:
    """A pool PV as the controller sees it."""

    name: str
    image_tag: str
    phase: str                       # Available | Bound | Released | Failed
    # spec.nodeAffinity's required nodeSelectorTerms, verbatim — identical across drivers.
    node_selector_terms: list[dict] = field(default_factory=list)
    last_used: str | None = None
    claim_ref: str | None = None     # spec.claimRef.name when reserved/bound
    terminating: bool = False


@dataclass(frozen=True)
class Node:
    """A schedulable node, reduced to the labels a PV's nodeAffinity can match on."""

    name: str
    labels: dict[str, str]
    schedulable: bool = True


@dataclass(frozen=True)
class PendingSandbox:
    """A Sandbox awaiting an upper. `pvc_name` is what its vct WILL generate — the PVC must
    be created under exactly that name for adoption to happen."""

    sandbox: str
    image_tag: str
    pvc_name: str


# --- actions ---------------------------------------------------------------

@dataclass(frozen=True)
class ReleasePv:
    """Clear spec.claimRef so `pv` goes Available. Recycles a Released PV, and rolls back a
    failed reservation — a miss must leave nothing behind or the pool leaks a volume."""

    pv: str
    reason: str


# --- the placement predicate ----------------------------------------------

def node_matches(terms: list[dict], node: Node) -> bool:
    """Does `node` satisfy a PV's nodeSelectorTerms? Terms OR'd, expressions AND'd."""
    if not terms:
        return True
    for term in terms:
        exprs = term.get("matchExpressions") or []
        fields = term.get("matchFields") or []
        # matchFields keys on node metadata, not labels; unevaluatable -> skip the term.
        if fields:
            continue
        if all(_expr_matches(e, node) for e in exprs):
            return True
    return False


def _expr_matches(expr: dict, node: Node) -> bool:
    key, op = expr.get("key", ""), expr.get("operator", "")
    values = expr.get("values") or []
    actual = node.labels.get(key)
    if op == "In":
        return actual is not None and actual in values
    if op == "NotIn":
        return actual is None or actual not in values
    if op == "Exists":
        return key in node.labels
    if op == "DoesNotExist":
        return key not in node.labels
    return False  # unknown operator: fail closed (do not place) rather than mis-place


def usable_pvs(pvs: list[PoolPv], nodes: list[Node], image_tag: str) -> list[PoolPv]:
    """Pool PVs that could actually serve a sandbox of `image_tag` right now: matching
    tag, Available, not terminating, unreserved, and reachable from at least one
    schedulable node."""
    live = [n for n in nodes if n.schedulable]
    return [
        pv
        for pv in pvs
        if pv.image_tag == image_tag
        and pv.phase == "Available"
        and not pv.terminating
        and pv.claim_ref is None
        and any(node_matches(pv.node_selector_terms, n) for n in live)
    ]


def candidates_for(
    want: PendingSandbox,
    pvs: list[PoolPv],
    nodes: list[Node],
    affinity: dict[str, str] | None = None,
) -> Iterator[PoolPv]:
    """PVs this sandbox could use, best-first. Ranking only — claim() decides freeness."""
    usable = usable_pvs(pvs, nodes, want.image_tag)
    mine = (affinity or {}).get(want.sandbox)
    for pv in usable:
        if pv.name == mine:
            yield pv
            break
    # `or ""` puts an undated PV at the end; name breaks ties for a stable order.
    for pv in sorted(usable, key=lambda p: (p.last_used or "", p.name), reverse=True):
        if pv.name != mine:
            yield pv


def plan_reclaim(pvs: list[PoolPv]) -> list[ReleasePv]:
    """Released PVs go back to the pool. k8s will not rebind one while its claimRef still
    names the late PVC, so skipping this silently stops all recycling."""
    return [
        ReleasePv(pv=pv.name, reason="PVC gone — return to the pool")
        for pv in pvs
        if pv.phase == "Released" and not pv.terminating
    ]
