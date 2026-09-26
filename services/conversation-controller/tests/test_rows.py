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
