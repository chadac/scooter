"""Tier 1 — the PURE placement core (no cluster)."""


from warm_store_controller.allocate import (
    Node,
    PendingSandbox,
    PoolPv,
    ReleasePv,
    candidates_for,
    node_matches,
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
    # "satisfied" for an unreadable constraint = a pod bound to an unreachable volume.
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

def test_a_volume_this_sandbox_warmed_wins_even_when_least_recently_used():
    pool = [pv("fresh", last_used="2026-08-27T10:00:00Z"), pv("mine", last_used="2026-01-01T00:00:00Z")]
    assert rank_candidates(pool, "conv-a", {"conv-a": "mine"})[0].name == "mine"


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


def test_TWO_sandboxes_can_prefer_the_SAME_volume():
    # Separate keys — an annotation ON the PV records only the last user.
    aff = {"conv-x": "A", "conv-y": "A"}
    pool = [pv("A", last_used="2026-01-01T00:00:00Z"), pv("B", last_used="2026-08-27T10:00:00Z")]
    assert rank_candidates(pool, "conv-x", aff)[0].name == "A"
    assert rank_candidates(pool, "conv-y", aff)[0].name == "A"


def test_affinity_outranks_recency():
    pool = [pv("hot", last_used="2026-08-27T10:00:00Z"), pv("mine", last_used="2026-01-01T00:00:00Z")]
    assert rank_candidates(pool, "conv-a", {"conv-a": "mine"})[0].name == "mine"


# --- candidate selection: ranking only. Freeness is decided by claim(), not here.

def test_the_sandboxs_OWN_pv_is_the_first_candidate():
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    pool = [pv("other"), pv("mine")]
    aff = {"conv-a": "mine"}
    assert [p.name for p in candidates_for(want, pool, [node("odin")], aff)] == ["mine", "other"]


def test_a_COLD_pool_offers_NO_candidates():
    # The shell reads this as "fall back to the vct" — a cold pool never blocks.
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    assert candidates_for(want, [], [node("odin")]) == []


def test_an_UNREACHABLE_pool_offers_NO_candidates():
    # Non-empty but topologically useless: every PV is pinned to a node we cannot use.
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    pool = [pv("on-thor", node_selector_terms=hostname_terms("thor"))]
    assert candidates_for(want, pool, [node("odin")]) == []


def test_candidates_are_offered_in_FALLBACK_order():
    # The shell takes the first it wins, so a lost race costs the next-best volume.
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    aff = {"conv-a": "mine"}
    pool = [
        pv("cold", last_used="2026-01-01T00:00:00Z"),
        pv("hot", last_used="2026-08-27T10:00:00Z"),
        pv("mine", last_used="2025-01-01T00:00:00Z"),
    ]
    assert [p.name for p in candidates_for(want, pool, [node("odin")], aff)] == ["mine", "hot", "cold"]


def test_candidates_EXCLUDE_unusable_pvs():
    want = PendingSandbox(sandbox="conv-a", image_tag=TAG, pvc_name="scooter-rw-conv-a")
    pool = [
        pv("ok"),
        pv("wrong-tag", image_tag="other"),
        pv("bound", phase="Bound"),
        pv("dying", terminating=True),
        pv("reserved", claim_ref="someone"),
    ]
    assert [p.name for p in candidates_for(want, pool, [node("odin")])] == ["ok"]


# --- reclaim ---------------------------------------------------------------

def test_released_pvs_go_back_to_the_pool():
    pool = [pv("done", phase="Released"), pv("live", phase="Bound"), pv("free", phase="Available")]
    acts = plan_reclaim(pool)
    assert [a.pv for a in acts if isinstance(a, ReleasePv)] == ["done"]


def test_a_TERMINATING_released_pv_is_left_alone():
    # Already resolved; touching it restarts the delete->terminating->re-read spin (#399).
    assert plan_reclaim([pv("dying", phase="Released", terminating=True)]) == []


def test_matchFields_term_is_SKIPPED_not_evaluated():
    # Pinned gap: unevaluatable -> unusable, never mis-placed. Unreachable today.
    terms = [{"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["odin"]}]}]
    assert node_matches(terms, node("odin")) is False


def test_a_matchFields_term_does_not_veto_a_sibling_LABEL_term():
    # Terms are OR'd: skipping one must not suppress a term we CAN confirm.
    terms = [
        {"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["thor"]}]},
        {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["odin"]}]},
    ]
    assert node_matches(terms, node("odin")) is True
