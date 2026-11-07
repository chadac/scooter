"""The controller's conversations-row writer, and the boundary that a Postgres outage can never take the reconcile loop down."""

import pytest

from conversation_controller.rows import ConversationRows, dsn_from_env, from_env


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
    """One connection is reused across writes."""
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
    """Postgres being down must not abort a reconcile pass."""
    rows = ConversationRows("dsn", connect=lambda _dsn: FakeConn(fail=True))
    assert rows.set_phase("conv-1", "Failed") is False


def test_a_failed_write_drops_the_connection_so_the_next_call_reconnects():
    """A broken connection is dropped so the next write reconnects."""
    conns = [FakeConn(fail=True), FakeConn()]
    opened = []

    def connect(_dsn):
        c = conns[len(opened)]
        opened.append(c)
        return c

    rows = ConversationRows("dsn", connect=connect)
    assert rows.set_phase("conv-1", "Failed") is False
    assert conns[0].closed, "the broken connection must be closed, not leaked"
    assert rows.set_phase("conv-1", "Failed") is True
    assert len(opened) == 2


def test_no_matching_row_is_false_but_not_an_error():
    """A missing row (deleted, or not created yet) is not a failure."""
    rows = ConversationRows("dsn", connect=lambda _dsn: FakeConn(rowcount=0))
    assert rows.set_phase("gone", "Failed") is False


def test_connect_failure_is_swallowed_too():
    def connect(_dsn):
        raise RuntimeError("no route to host")

    rows = ConversationRows("dsn", connect=connect)
    assert rows.set_phase("conv-1", "Failed") is False


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
    """Every phase the controller writes can be mirrored."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)
    assert rows.set_phase("conv-1", phase) is True
    assert conn.executed[0][1] == (phase, "conv-1")


def test_the_connection_overrides_the_roles_read_only_default():
    """modules/postgres.nix pins every write role read-only, and without the per-connection override every best-effort UPDATE fails silently."""
    from conversation_controller.rows import CONNECT_OPTIONS

    assert "default_transaction_read_only=off" in CONNECT_OPTIONS


# --- assignment: the WHERE clauses that keep ownership monotonic ------------------------------


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
    """A claim that lost to a newer epoch, or found no row, is a normal outcome."""
    conn = FakeConn(rowcount=0)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.set_assignment("c1", "host-3", 2) is False
    assert not conn.closed, "a lost claim is a normal outcome — it must not drop the connection"


def test_release_keeps_the_generation_as_a_high_water_mark():
    """A release clears host_pod but keeps host_generation, so no stale epoch can claim next."""
    conn = FakeConn()
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    rows.release_assignment("c1", 4)

    sql, params = conn.executed[0]
    assert "SET host_pod = NULL" in sql
    assert "host_generation" not in sql.split("WHERE")[0], "the epoch must survive a release"
    assert "%s >= host_generation" in sql
    assert params == ("c1", 4)


def test_release_cannot_detach_a_pod_assigned_at_a_newer_epoch():
    """A stale controller holds a lower epoch than the row, so its release matches nothing."""
    conn = FakeConn(rowcount=0)
    rows = ConversationRows("dsn", connect=lambda _dsn: conn)

    assert rows.release_assignment("c1", 1) is False


def test_reapable_read_failure_is_none_so_the_reaper_skips():
    rows = ConversationRows("dsn", connect=lambda _dsn: FakeConn(fail=True))
    assert rows.reapable_sandboxes(0) is None
