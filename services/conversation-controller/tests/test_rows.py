"""The controller's conversations-row writer.

What matters here is not that it issues an UPDATE — it is that it CANNOT take the reconcile loop
down. The controller's job is assignment; a Postgres outage must cost a stale `phase` column and
nothing else. Every test below is really a statement about that boundary.
"""

import pytest

from conversation_controller.rows import ConversationRows, dsn_from_env, from_env
from conversation_controller.loop import _mirror_phase


class FakeCursor:
    def __init__(self, conn, rowcount=1, fail=False):
        self._conn = conn
        self.rowcount = rowcount
        self._fail = fail

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params):
        if self._fail:
            raise RuntimeError("pg is down")
        self._conn.executed.append((" ".join(sql.split()), params))


class FakeConn:
    def __init__(self, rowcount=1, fail=False):
        self.executed = []
        self.closed = False
        self._rowcount = rowcount
        self._fail = fail

    def cursor(self):
        return FakeCursor(self, rowcount=self._rowcount, fail=self._fail)

    def close(self):
        self.closed = True


def test_set_phase_updates_the_row():
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.set_phase("conv-1", "Failed") is True
    assert conn.executed == [("UPDATE conversations SET phase = %s WHERE id = %s", ("Failed", "conv-1"))]


def test_connection_is_opened_once_and_reused():
    """A connection per write would add a connect to every tick of a loop that runs forever."""
    conn = FakeConn()
    opens = []

    def connect(dsn):
        opens.append(dsn)
        return conn

    rows = ConversationRows("dsn", connect=connect)
    rows.set_phase("conv-1", "Assigned")
    rows.set_phase("conv-2", "Suspended")
    assert opens == ["dsn"]
    assert len(conn.executed) == 2


def test_a_write_failure_never_raises():
    """THE BOUNDARY: Postgres being down must not abort a reconcile pass."""
    rows = ConversationRows("dsn", connect=lambda _dsn: FakeConn(fail=True))
    assert rows.set_phase("conv-1", "Failed") is False


def test_a_failed_write_drops_the_connection_so_the_next_call_reconnects():
    """Without this, one broken connection silently swallows every later write until a restart."""
    conns = [FakeConn(fail=True), FakeConn()]
    opened = []

    def connect(_dsn):
        c = conns[len(opened)]
        opened.append(c)
        return c

    rows = ConversationRows("dsn", connect=connect)
    assert rows.set_phase("conv-1", "Failed") is False
    assert conns[0].closed, "the broken connection must be closed, not leaked"
    # The recovery that matters: the very next write succeeds on a fresh connection.
    assert rows.set_phase("conv-1", "Failed") is True
    assert len(opened) == 2


def test_no_matching_row_is_false_but_not_an_error():
    """A deleted conversation, or a row that does not exist yet mid-migration. Not a failure."""
    rows = ConversationRows("dsn", connect=lambda _dsn: FakeConn(rowcount=0))
    assert rows.set_phase("gone", "Failed") is False


def test_connect_failure_is_swallowed_too():
    def connect(_dsn):
        raise RuntimeError("no route to host")

    rows = ConversationRows("dsn", connect=connect)
    assert rows.set_phase("conv-1", "Failed") is False


def test_mirror_phase_is_a_noop_without_a_writer():
    """No DSN configured is a SUPPORTED deployment: the controller runs exactly as it did before."""
    _mirror_phase(None, "conv-1", "Failed")  # must not raise


def test_dsn_from_env_returns_none_when_unconfigured(monkeypatch):
    for k in ("AGENT_HOST_DB_DSN", "AGENT_HOST_DB_HOST"):
        monkeypatch.delenv(k, raising=False)
    assert dsn_from_env() is None
    assert from_env() is None


def test_dsn_is_built_from_the_same_env_the_other_services_read(monkeypatch):
    monkeypatch.delenv("AGENT_HOST_DB_DSN", raising=False)
    monkeypatch.setenv("AGENT_HOST_DB_HOST", "pg.internal")
    monkeypatch.setenv("AGENT_HOST_DB_PORT", "5433")
    monkeypatch.setenv("AGENT_HOST_DB_PASSWORD", "secret")
    monkeypatch.setenv("AGENT_HOST_DB_SSLMODE", "require")
    dsn = dsn_from_env()
    for expected in ("host=pg.internal", "port=5433", "dbname=agent_host",
                     "user=conversation_controller", "password=secret", "sslmode=require"):
        assert expected in dsn


def test_an_explicit_dsn_wins(monkeypatch):
    monkeypatch.setenv("AGENT_HOST_DB_DSN", "postgres://explicit/db")
    monkeypatch.setenv("AGENT_HOST_DB_HOST", "ignored")
    assert dsn_from_env() == "postgres://explicit/db"


@pytest.mark.parametrize("phase", ["Failed", "Pending", "Suspended", "Assigned"])
def test_every_phase_the_controller_writes_can_be_mirrored(phase):
    """Guards the set: Failed/Pending/the drift Suspended are phases NO other writer produces."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)
    assert rows.set_phase("conv-1", phase) is True
    assert conn.executed[0][1] == (phase, "conv-1")


def test_the_connection_overrides_the_roles_read_only_default():
    """THE SILENT-FAILURE GUARD.

    modules/postgres.nix pins every write role read-only (`ALTER ROLE ... SET
    default_transaction_read_only = on`) and expects each writer to override it per-connection — a
    startup option outranks an ALTER ROLE SET. Drop this and the UPDATE fails with "cannot execute
    UPDATE in a read-only transaction"; because row writes are best-effort, that shows up as a
    warning log and a phase column that never changes, with CI perfectly green.
    """
    from conversation_controller.rows import CONNECT_OPTIONS

    assert "default_transaction_read_only=off" in CONNECT_OPTIONS


# --- sync_phases: the convergent write ------------------------------------------------------
#
# set_phase alone leaves two permanent holes — a conversation that never transitions again is
# never mirrored, and a dropped best-effort write is dropped for good. These pin the sweep that
# closes both, and pin that it stays cheap enough to run every tick.


def test_sync_phases_updates_only_rows_that_differ():
    """IS DISTINCT FROM, not `<>`: a NULL phase (every row predating the mirror) is exactly the
    case that must be backfilled, and `NULL <> 'Assigned'` is NULL — it would match nothing."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.sync_phases([("a", "Assigned"), ("b", "Failed")])

    sql, params = conn.executed[0]
    assert "IS DISTINCT FROM" in sql
    assert "(%s::text, %s::text),(%s::text, %s::text)" in sql
    assert params == ["a", "Assigned", "b", "Failed"]


def test_sync_phases_is_one_statement_for_the_whole_fleet():
    """This runs on every tick. One query per conversation would make the steady state cost scale
    with fleet size for a pass that, by construction, usually changes nothing."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.sync_phases([(f"c{i}", "Assigned") for i in range(200)])

    assert len(conn.executed) == 1


def test_sync_phases_chunks_past_the_bind_parameter_limit():
    """Two bind params per conversation against Postgres' 65535 cap: a big enough fleet in one
    statement is not a slow query, it is a hard failure of the whole sweep."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.sync_phases([(f"c{i}", "Assigned") for i in range(1200)])

    assert len(conn.executed) == 3
    assert all(len(params) <= 1000 for _sql, params in conn.executed)


def test_sync_phases_of_nothing_issues_no_query():
    """An empty cluster must not even open a connection."""
    opens = []
    rows = ConversationRows("dsn", connect=lambda dsn: opens.append(dsn) or FakeConn())

    assert rows.sync_phases([]) == 0
    assert opens == []


def test_sync_phases_survives_postgres_being_down():
    """The boundary this whole module exists to hold: assignment keeps working without Postgres."""
    conn = FakeConn(fail=True)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.sync_phases([("a", "Assigned")]) == 0
    assert conn.closed, "a connection that errored must be dropped so the next tick reconnects"


def test_sync_phases_skips_conversations_with_no_phase_on_the_cr():
    """_state defaults a status-less CR to "Pending". That default is a guess, not an observation,
    and the pass materializes the real phase moments later — mirroring the guess would race it."""
    from conversation_controller.loop import _sync_rows
    from conversation_controller.reconcile import ConversationState

    class Recorder:
        def __init__(self):
            self.synced = None

        def sync_phases(self, pairs):
            self.synced = pairs
            return 0

        def sync_assignments(self, triples):
            return 0

    rec = Recorder()
    _sync_rows(
        rec,
        [
            ConversationState(name="has-phase", host_pod=None, phase="Assigned", generation=0),
            ConversationState(name="no-phase", host_pod=None, phase="Pending", generation=0, phase_present=False),
        ],
    )

    assert rec.synced == [("has-phase", "Assigned")]


def test_sync_phases_is_a_no_op_without_a_database():
    """No DSN configured is a supported deployment, not a degraded one."""
    from conversation_controller.loop import _sync_rows

    _sync_rows(None, [])  # must not raise


# --- assignment: where the monotonicity comes from -------------------------------------------
#
# The CR gets monotonicity from apiserver optimistic concurrency. The row has to get it from the
# database, because the alternative — a leader lease — is not mutual exclusion: a paused replica
# still believes it holds one, wakes with a stale view, and would overwrite a newer assignment.
# These tests pin the WHERE clauses that make that impossible.


def test_set_assignment_claims_only_past_a_newer_generation():
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.set_assignment("c1", "host-3", 7) is True

    sql, params = conn.executed[0]
    assert sql == (
        "UPDATE conversations SET host_pod = %s, host_generation = %s "
        "WHERE id = %s AND %s > host_generation"
    )
    assert params == ("host-3", 7, "c1", 7)


def test_a_losing_claim_is_not_an_error():
    """False means EITHER the claim lost to a newer epoch OR the row is gone. Neither is something
    the controller can act on, and neither may interrupt the pass."""
    conn = FakeConn(rowcount=0)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.set_assignment("c1", "host-3", 2) is False
    assert not conn.closed, "a lost claim is a normal outcome — it must not drop the connection"


def test_release_keeps_the_generation_as_a_high_water_mark():
    """Clearing host_generation would reset the fence to 0 and let any stale epoch claim next. A
    release says 'no pod owns this', not 'ownership never advanced'."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.release_assignment("c1", 4)

    sql, params = conn.executed[0]
    assert "SET host_pod = NULL" in sql
    assert "host_generation" not in sql.split("WHERE")[0], "the epoch must survive a release"
    assert "%s >= host_generation" in sql
    assert params == ("c1", 4)


def test_release_cannot_detach_a_pod_assigned_at_a_newer_epoch():
    """The >= is the whole guard: a stale controller holds a LOWER epoch than the row and its
    release must match nothing, or it would unassign a conversation someone else just claimed."""
    conn = FakeConn(rowcount=0)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.release_assignment("c1", 1) is False


def test_sync_assignments_converges_without_going_backwards():
    """>= because this carries the CR's CURRENT epoch, not a new one: the current controller
    refreshes, a stale one (lower epoch) is rejected."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.sync_assignments([("a", "host-1", 3), ("b", None, 0)])

    sql, params = conn.executed[0]
    assert "v.gen >= c.host_generation" in sql
    assert "c.host_pod IS DISTINCT FROM v.host_pod OR c.host_generation <> v.gen" in sql
    assert params == ["a", "host-1", 3, "b", None, 0]


def test_sync_assignments_is_one_statement_and_chunks():
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.sync_assignments([(f"c{i}", "host-1", 1) for i in range(200)])
    assert len(conn.executed) == 1

    conn2 = FakeConn()
    rows2 = ConversationRows("dsn", connect=lambda _dsn: conn2)
    rows2.sync_assignments([(f"c{i}", "host-1", 1) for i in range(1100)])
    assert len(conn2.executed) == 3


def test_sync_assignments_survives_postgres_being_down():
    conn = FakeConn(fail=True)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.sync_assignments([("a", "host-1", 1)]) == 0
    assert conn.closed


def test_the_sweep_carries_every_conversation_including_the_unassigned():
    """Unlike phase, an unassigned conversation is NOT skipped: host_pod=None is the observation
    that no pod owns it, and the row has to learn that too."""
    from conversation_controller.loop import _sync_rows
    from conversation_controller.reconcile import ConversationState

    class Recorder:
        def __init__(self):
            self.assignments = None

        def sync_phases(self, pairs):
            return 0

        def sync_assignments(self, triples):
            self.assignments = triples
            return 0

    rec = Recorder()
    _sync_rows(
        rec,
        [
            ConversationState(name="assigned", host_pod="host-1", phase="Assigned", generation=5),
            ConversationState(name="pending", host_pod=None, phase="Pending", generation=0),
        ],
    )

    assert rec.assignments == [("assigned", "host-1", 5), ("pending", None, 0)]
