"""Tier 1 — the PURE placement core (no cluster)."""


from warm_store_controller.allocate import (
    LetVctProvision,
    Node,
    PendingSandbox,
    PoolPv,
    ReleasePv,
    ReservePv,
    node_matches,
    plan_allocation,
    plan_reclaim,
    rank_candidates,
    usable_pvs,
)

TAG = "scooter-git-abc123"


def hostname_terms(*hosts):
    """A local-path PV's topology: pinned to specific node hostnames."""
    return [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": list(hosts)}]}]


def zone_terms(*zones):
    """An EBS PV's topology: pinned to AZs. Same SHAPE as local-path — the point of the
    generic predicate."""
    return [{"matchExpressions": [{"key": "topology.ebs.csi.aws.com/zone", "operator": "In", "values": list(zones)}]}]


def pv(name, **kw):
    return PoolPv(name=name, image_tag=kw.pop("image_tag", TAG), phase=kw.pop("phase", "Available"), **kw)


def node(name, **labels):
    return Node(name=name, labels={"kubernetes.io/hostname": name, **labels})


# --- the topology predicate ------------------------------------------------

def test_no_terms_matches_anything():
    assert node_matches([], node("odin")) is True


def test_hostname_in_matches_that_node_only():
    assert node_matches(hostname_terms("odin"), node("odin")) is True
    assert node_matches(hostname_terms("odin"), node("thor")) is False


def test_ebs_zone_uses_the_same_rule():
    # One predicate, both drivers — no per-driver special case.
    terms = zone_terms("us-east-1a")
    n_a = Node(name="i-1", labels={"topology.ebs.csi.aws.com/zone": "us-east-1a"})
    n_b = Node(name="i-2", labels={"topology.ebs.csi.aws.com/zone": "us-east-1b"})
    assert node_matches(terms, n_a) is True
    assert node_matches(terms, n_b) is False


def test_terms_are_ORed_expressions_are_ANDed():
    two_terms = hostname_terms("odin") + hostname_terms("thor")
    assert node_matches(two_terms, node("thor")) is True
    anded = [{"matchExpressions": [
        {"key": "kubernetes.io/hostname", "operator": "In", "values": ["odin"]},
        {"key": "disk", "operator": "In", "values": ["ssd"]},
    ]}]
    assert node_matches(anded, node("odin")) is False           # missing disk=ssd
    assert node_matches(anded, node("odin", disk="ssd")) is True


def test_exists_and_notin():
    assert node_matches([{"matchExpressions": [{"key": "disk", "operator": "Exists"}]}], node("o", disk="ssd")) is True
    assert node_matches([{"matchExpressions": [{"key": "disk", "operator": "DoesNotExist"}]}], node("o")) is True
    assert node_matches(
        [{"matchExpressions": [{"key": "zone", "operator": "NotIn", "values": ["bad"]}]}], node("o", zone="good")
    ) is True


def test_UNKNOWN_operator_does_not_match():
    # A constraint we cannot evaluate must never read as "satisfied" — that is how a pod
    # gets bound to a volume it cannot reach.
    weird = [{"matchExpressions": [{"key": "k", "operator": "Gt", "values": ["1"]}]}]
    assert node_matches(weird, node("odin", k="5")) is False


# --- usability filter ------------------------------------------------------

def test_usable_excludes_wrong_tag_nonavailable_terminating_and_reserved():
    nodes = [node("odin")]
    pool = [
        pv("ok", node_selector_terms=hostname_terms("odin")),
        pv("wrong-tag", image_tag="other", node_selector_terms=hostname_terms("odin")),
        pv("bound", phase="Bound", node_selector_terms=hostname_terms("odin")),
        pv("dying", terminating=True, node_selector_terms=hostname_terms("odin")),
        pv("reserved", claim_ref="someone", node_selector_terms=hostname_terms("odin")),
    ]
    assert [p.name for p in usable_pvs(pool, nodes, TAG)] == ["ok"]


def test_usable_excludes_a_pv_no_LIVE_node_can_reach():
    # THE node-local case: the PV is fine, its node is gone/cordoned.
    pool = [pv("on-thor", node_selector_terms=hostname_terms("thor"))]
    assert usable_pvs(pool, [node("odin")], TAG) == []
    assert usable_pvs(pool, [Node(name="thor", labels={"kubernetes.io/hostname": "thor"}, schedulable=False)], TAG) == []
    assert [p.name for p in usable_pvs(pool, [node("thor")], TAG)] == ["on-thor"]


# --- ranking ---------------------------------------------------------------

def test_own_pv_wins_even_when_least_recently_used():
    pool = [
        pv("fresh", last_used="2026-08-27T10:00:00Z", last_sandbox="other"),
        pv("mine", last_used="2026-01-01T00:00:00Z", last_sandbox="conv-a"),
    ]
    assert rank_candidates(pool, "conv-a")[0].name == "mine"


def test_otherwise_MOST_recently_used_first():
    # MRU: a hot set gets genuinely warm and the cold tail ages out reapably.
    pool = [
        pv("recent", last_used="2026-08-27T10:00:00Z"),
        pv("old", last_used="2026-01-01T00:00:00Z"),
    ]
    assert [p.name for p in rank_candidates(pool, "conv-x")] == ["recent", "old"]


def test_an_UNKNOWN_age_pv_sorts_last():
    # Least attractive to reuse, most attractive to reap.
    pool = [pv("nostamp"), pv("dated", last_used="2026-01-01T00:00:00Z")]
    assert [p.name for p in rank_candidates(pool, "conv-x")] == ["dated", "nostamp"]


def test_own_pv_beats_a_more_recently_used_one():
    # Ownership outranks recency: the sandbox's own volume holds ITS builds.
    pool = [
        pv("hot", last_used="2026-08-27T10:00:00Z", last_sandbox="other"),
        pv("mine", last_used="2026-01-01T00:00:00Z", last_sandbox="conv-a"),
    ]
    assert rank_candidates(pool, "conv-a")[0].name == "mine"


# --- allocation ------------------------------------------------------------

def test_allocates_the_sandboxs_own_pv_when_available():
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    pool = [pv("other"), pv("mine", last_sandbox="conv-a")]
    [act] = plan_allocation([want], pool, [node("odin")], set())
    assert isinstance(act, ReservePv)
    assert (act.pv, act.pvc_name) == ("mine", "scooter-rw-conv-a")
    assert "own warm PV" in act.reason


def test_falls_back_to_the_vct_when_the_pool_is_COLD():
    # Not an error — this is what keeps the pool an optimization, never a dependency.
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    [act] = plan_allocation([want], [], [node("odin")], set())
    assert isinstance(act, LetVctProvision)


def test_falls_back_when_every_pv_is_UNREACHABLE():
    # The pool is non-empty but topologically useless — must still not block.
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    pool = [pv("on-thor", node_selector_terms=hostname_terms("thor"))]
    [act] = plan_allocation([want], pool, [node("odin")], set())
    assert isinstance(act, LetVctProvision)


def test_two_sandboxes_never_get_the_SAME_pv_in_one_pass():
    a = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    b = PendingSandbox(sandbox="conv-b", image_tag=TAG, pvc_name="scooter-rw-conv-b")
    pool = [pv("only-one")]
    acts = plan_allocation([a, b], pool, [node("odin")], set())
    reserved = [x for x in acts if isinstance(x, ReservePv)]
    assert len(reserved) == 1
    assert any(isinstance(x, LetVctProvision) for x in acts)


def test_IN_FLIGHT_pv_is_withheld_from_a_later_pass():
    # THE RACE: claimRef makes the write exclusive, but a PV chosen last pass may still
    # read Available until k8s observes the binding. Choosing it again double-books it.
    want = PendingSandbox(sandbox="conv-b", image_tag=TAG, pvc_name="scooter-rw-conv-b")
    pool = [pv("already-taken")]
    [act] = plan_allocation([want], pool, [node("odin")], {"already-taken"})
    assert isinstance(act, LetVctProvision)


# --- reclaim ---------------------------------------------------------------

def test_released_pvs_go_back_to_the_pool():
    pool = [pv("done", phase="Released"), pv("live", phase="Bound"), pv("free", phase="Available")]
    acts = plan_reclaim(pool)
    assert [a.pv for a in acts if isinstance(a, ReleasePv)] == ["done"]


def test_a_TERMINATING_released_pv_is_left_alone():
    # Already resolved; touching it restarts the delete->terminating->re-read spin (#399).
    assert plan_reclaim([pv("dying", phase="Released", terminating=True)]) == []


def test_matchFields_term_is_SKIPPED_not_evaluated():
    # Documented gap, pinned so it stays deliberate: unevaluatable -> unusable, never
    # mis-placed. Unreachable today (volume topology emits no matchFields).
    terms = [{"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["odin"]}]}]
    assert node_matches(terms, node("odin")) is False


def test_a_matchFields_term_does_not_veto_a_sibling_LABEL_term():
    # Terms are OR'd: skipping the unevaluatable one must not suppress a term we CAN
    # confirm, or one exotic term would strand an otherwise usable PV.
    terms = [
        {"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["thor"]}]},
        {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["odin"]}]},
    ]
    assert node_matches(terms, node("odin")) is True
