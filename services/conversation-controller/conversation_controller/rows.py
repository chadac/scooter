"""The controller's write path to `agent_host.conversations`.

Why the controller needs Postgres at all: the conversation row is becoming the source of truth for
a conversation, and the controller writes three phases nothing else does — Failed (the zombie
escalation), Pending, and the Suspended drift repair. Until those reach the row, a reader cannot
trust `conversations.phase`: a Failed conversation would read as "running", which is the bug
statusForPhase in the router exists to prevent. See PR #654.

BEST-EFFORT, ALWAYS. Every method swallows its errors and returns a bool. The controller's job is
assignment; it must keep reconciling when Postgres is unreachable, exactly as it keeps reconciling
when a single CR patch fails. The CR remains authoritative for now, so a dropped row write costs
staleness in a field nothing reads yet — not correctness.

Deliberately NOT here: host_pod / host_generation. Assignment moves with the reconcile-loop port,
where the write is a CONDITIONAL update (`WHERE $gen > host_generation`) rather than a blind one, and
that monotonicity deserves its own review rather than riding along with "the controller can now
reach Postgres".
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_C = {"component": "rows"}

# EVERY write role in this platform is pinned read-only at the role level
# (`ALTER ROLE ... SET default_transaction_read_only = on`, modules/postgres.nix) and each writer
# overrides it on its own connection — a startup option outranks an ALTER ROLE SET. Without this the
# UPDATE fails with "cannot execute UPDATE in a read-only transaction", and because row writes are
# best-effort that surfaces as a warning log and a phase column that silently never updates. The
# router does the same thing in its pool config (buildWritePoolConfig).
CONNECT_OPTIONS = "-c default_transaction_read_only=off"


def dsn_from_env() -> str | None:
    """Build the agent_host DSN from the same AGENT_HOST_DB_* env the router and agent-host read.

    Returns None when unconfigured, which is a supported deployment: the controller then skips row
    writes entirely and behaves exactly as it did before it had a database.
    """
    if dsn := os.environ.get("AGENT_HOST_DB_DSN"):
        return dsn
    host = os.environ.get("AGENT_HOST_DB_HOST")
    if not host:
        return None
    parts = [
        f"host={host}",
        f"port={os.environ.get('AGENT_HOST_DB_PORT', '5432')}",
        f"dbname={os.environ.get('AGENT_HOST_DB_NAME', 'agent_host')}",
        f"user={os.environ.get('AGENT_HOST_DB_USER', 'conversation_controller')}",
    ]
    if password := os.environ.get("AGENT_HOST_DB_PASSWORD"):
        parts.append(f"password={password}")
    if sslmode := os.environ.get("AGENT_HOST_DB_SSLMODE"):
        parts.append(f"sslmode={sslmode}")
    return " ".join(parts)


class ConversationRows:
    """One lazily-opened, self-healing connection.

    One connection rather than a pool: phase writes are rare (a transition, a drift repair) and the
    loop is single-threaded under a leader lease, so a pool would add moving parts for no
    concurrency. The connection is reopened on the next call after any failure, so a Postgres
    restart costs one dropped write rather than every write until the controller is restarted.
    """

    def __init__(self, dsn: str, connect=None) -> None:
        self._dsn = dsn
        self._conn = None
        # Injectable so the failure paths are testable without a Postgres.
        self._connect_fn = connect or self._psycopg_connect

    @staticmethod
    def _psycopg_connect(dsn: str):
        import psycopg  # imported here so the module is importable without the driver installed

        # autocommit: each write is one statement and must land immediately. Without it psycopg
        # opens a transaction that nothing commits, and every write would be silently rolled back
        # when the connection drops.
        return psycopg.connect(dsn, autocommit=True, connect_timeout=5, options=CONNECT_OPTIONS)

    def _cursor(self):
        if self._conn is None:
            self._conn = self._connect_fn(self._dsn)
        return self._conn.cursor()

    def _drop(self) -> None:
        """Discard a connection that errored, so the next call reconnects rather than reusing it."""
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - closing a broken connection may itself fail
                pass

    def set_phase(self, conversation_id: str, phase: str) -> bool:
        """Mirror a phase the controller just patched onto the CR. True when the row was updated.

        A 0-row result is NOT an error: the conversation may have been deleted, or (in a deployment
        mid-migration) may have no row yet. It returns False so a caller could count it, and says
        nothing — logging every miss would be noise on every tick.
        """
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET phase = %s WHERE id = %s",
                    (phase, conversation_id),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001 - best-effort by contract
            self._drop()
            logger.warning(
                "conversations row phase write failed",
                extra={**_C, "conversation_id": conversation_id, "phase": phase, "error": str(err)},
            )
            return False

    def close(self) -> None:
        self._drop()


def from_env(connect=None) -> ConversationRows | None:
    """Build a writer from the environment, or None when no database is configured."""
    dsn = dsn_from_env()
    if not dsn:
        logger.info("no agent_host DSN configured — controller will not mirror phases to the row", extra=_C)
        return None
    return ConversationRows(dsn, connect=connect)
