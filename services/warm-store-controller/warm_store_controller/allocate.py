"""PV placement — the pure decision core for handing a sandbox a warm overlay upper.

The agent-host no longer claims volumes. It always attaches the `scooter-rw`
volumeClaimTemplate, so every Sandbox has ONE shape. Warm placement happens at the
PV<->PVC binding layer instead: this controller pre-creates the PVC under the name the
vct would generate (`scooter-rw-<sandbox>`), pre-bound via `claimRef` to a PV it chose,
and the vct ADOPTS it. If we place nothing, the vct provisions a fresh empty upper — so
the pool stays a pure optimization and a cold (or entirely down) pool never blocks a
conversation.

Why the binding layer and not the PVC layer: a vct is a GENERATOR, not a fallback.
Pairing one with a same-named volume does not error — the vct SILENTLY WINS and the
pooled volume is orphaned. And `spec.volumeClaimTemplates` is IMMUTABLE, so the old
"omit the vct when claimed" trick froze each Sandbox's shape at birth with no way back.

Placement is PROPOSE -> VERIFY -> COMMIT -> FALL BACK. We do not model node-local vs.
EBS-AZ vs. capacity as separate rules: a PV states its own placement constraint in
`spec.nodeAffinity` as standard `nodeSelectorTerms` (local-path keys on
`kubernetes.io/hostname`, EBS on `topology.ebs.csi.aws.com/zone`), so ONE predicate
covers every driver — including constraints nobody enumerated.

See todo/draft/WARM_STORE_PV_OWNERSHIP.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The finalizer that makes a pool PV the controller's exclusively. ownerReferences CANNOT
# work here: a PV is cluster-scoped and a namespaced owner is rejected at GC time with
# `OwnerRefInvalidNamespace ... does not exist in namespace ""` (verified — the PV simply
# survives). A finalizer gives the same guarantee positively: nothing reaps a pool PV out
# from under us until we remove it.
PV_FINALIZER = "scooter.io/warm-store"

# PV labels/annotations. Keyed by image tag for the same reason PVCs were: the upper is an
# overlay whose LOWER is the sandbox image, so a PV warmed against one tag is meaningless
# (and corrupting) under another.
LBL_WARM_STORE = "scooter.io/warm-store"      # image content tag — the version key
ANN_LAST_USED = "scooter.io/last-used"        # rfc3339, for LRU
ANN_LAST_SANDBOX = "scooter.io/last-sandbox"  # the sandbox that last used this PV


@dataclass(frozen=True)
class PoolPv:
    """A pool PV as the controller sees it."""

    name: str
    image_tag: str
    phase: str                       # Available | Bound | Released | Failed
    # spec.nodeAffinity's required nodeSelectorTerms, verbatim. The shape is identical
    # across drivers, which is what lets one predicate serve all of them.
    node_selector_terms: list[dict] = field(default_factory=list)
    last_used: str | None = None
    last_sandbox: str | None = None  # ANN_LAST_SANDBOX — drives preferential reuse
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
    """A Sandbox that wants an upper: Running, overlay-store on, and its `scooter-rw`
    PVC does not exist yet. `pvc_name` is what the vct WILL generate — we must create it
    under exactly that name for the adoption to happen."""

    sandbox: str
    image_tag: str
    pvc_name: str


# --- actions ---------------------------------------------------------------

@dataclass(frozen=True)
class ReservePv:
    """Pre-bind `pv` to `pvc_name` (patch spec.claimRef) and create that PVC. The vct then
    adopts it instead of provisioning. Reversible: see ReleasePv."""

    pv: str
    pvc_name: str
    sandbox: str
    reason: str


@dataclass(frozen=True)
class ReleasePv:
    """Return `pv` to the pool: clear spec.claimRef so it goes Available. Used both to
    recycle a Released PV and to ROLL BACK a reservation that failed to schedule — a
    failed candidate must leave nothing behind, or the fallback loop leaks a volume on
    every miss."""

    pv: str
    reason: str


@dataclass(frozen=True)
class LetVctProvision:
    """Place nothing — no suitable PV. The Sandbox's vct provisions a fresh empty upper.
    Not an error: this is the cold-pool path, and it is why the pool never blocks."""

    sandbox: str
    reason: str


AllocAction = ReservePv | ReleasePv | LetVctProvision


# --- the placement predicate ----------------------------------------------

def node_matches(terms: list[dict], node: Node) -> bool:
    """Does `node` satisfy a PV's required nodeSelectorTerms? Terms are OR'd,
    matchExpressions within a term AND'd; no terms = no constraint.

    Supports only the operators volume topology uses (In, NotIn, Exists, DoesNotExist).
    Anything unrecognised fails CLOSED — see _expr_matches. PR #403."""
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


def rank_candidates(pvs: list[PoolPv], sandbox: str) -> list[PoolPv]:
    """Best-first. The sandbox's OWN previous PV wins — that is its warm store, already
    holding its builds. Otherwise MOST-recently-used.

    MRU, not LRU. Spreading load across the pool keeps every volume marginally warm and
    none properly warm, and leaves nothing safely reapable. Concentrating reuse on the
    hot set makes those volumes genuinely warm and lets the cold tail age out untouched,
    so a reaper can retire it on age alone. Ties break on name for determinism."""
    return sorted(
        pvs,
        key=lambda p: (
            0 if p.last_sandbox == sandbox else 1,
            _invert(p.last_used),
            p.name,
        ),
    )


def _invert(stamp: str | None) -> tuple[int, str]:
    """Sort key that puts NEWER first while keeping the rest of the tuple ascending.
    (0, "") for a missing stamp sorts it LAST — an unknown-age volume is the least
    attractive to reuse and the most attractive to reap."""
    if not stamp:
        return (1, "")
    # Invert lexicographic order by complementing each character within the rfc3339
    # alphabet, so a plain ascending sort yields descending timestamps.
    return (0, "".join(chr(0x7E - ord(c)) for c in stamp))


def plan_allocation(
    pending: list[PendingSandbox],
    pvs: list[PoolPv],
    nodes: list[Node],
    in_flight: set[str],
) -> list[AllocAction]:
    """Decide placement for every sandbox awaiting an upper.

    `in_flight` is the reservation set: PVs whose claimRef patch has been issued but whose
    binding k8s has not yet observed. claimRef makes the WRITE exclusive, but two
    decisions in one pass (or across a fast pair of passes) could still select the same
    Available PV before either patch lands — so a chosen PV is withheld from every later
    choice. The shell owns the set's TTL: a crash mid-decision must not strand a PV as
    permanently 'in flight'.

    Pure: returns actions, applies nothing. One action per pending sandbox.
    """
    actions: list[AllocAction] = []
    taken: set[str] = set(in_flight)

    for want in pending:
        candidates = [p for p in usable_pvs(pvs, nodes, want.image_tag) if p.name not in taken]
        if not candidates:
            actions.append(
                LetVctProvision(
                    sandbox=want.sandbox,
                    reason="no usable pool PV for this tag/topology — vct provisions a fresh upper",
                )
            )
            continue
        best = rank_candidates(candidates, want.sandbox)[0]
        taken.add(best.name)
        own = best.last_sandbox == want.sandbox
        actions.append(
            ReservePv(
                pv=best.name,
                pvc_name=want.pvc_name,
                sandbox=want.sandbox,
                reason="reusing this sandbox's own warm PV" if own else "assigning a warm pool PV",
            )
        )
    return actions


def plan_reclaim(pvs: list[PoolPv]) -> list[AllocAction]:
    """Released PVs (their PVC is gone) go back to the pool by clearing claimRef.

    A Released PV still names its late PVC in claimRef, and k8s will NOT rebind it while
    that dangling reference stands — so without this the pool silently stops recycling
    and every wake falls through to a fresh empty upper.
    """
    return [
        ReleasePv(pv=pv.name, reason="PVC gone — return to the pool")
        for pv in pvs
        if pv.phase == "Released" and not pv.terminating
    ]
