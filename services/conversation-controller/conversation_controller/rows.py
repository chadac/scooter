"""The controller's access to `agent_host.conversations`, the source of truth for placement.

Every method swallows its errors: a failed read skips the tick, a failed write is retried
on the next one.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_C = {"component": "rows"}

# Every write role is pinned read-only at the role level (modules/postgres.nix), and a writer
# overrides that on its own connection.
CONNECT_OPTIONS = "-c default_transaction_read_only=off"



def dsn_from_env() -> str | None:
    """Build the agent_host DSN from the AGENT_HOST_DB_* env, or None when no database is configured."""
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
    """One lazily-opened connection, reopened on the next call after any failure."""

    def __init__(self, dsn: str, connect=None) -> None:
        self._dsn = dsn
        self._conn = None
        self._connect_fn = connect or self._psycopg_connect

    @staticmethod
    def _psycopg_connect(dsn: str):
        import psycopg  # imported here so the module is importable without the driver installed

        # Each write is one statement that must land immediately.
        return psycopg.connect(dsn, autocommit=True, connect_timeout=5, options=CONNECT_OPTIONS)

    def _cursor(self):
        if self._conn is None:
            self._conn = self._connect_fn(self._dsn)
        return self._conn.cursor()

    def _drop(self) -> None:
        """Discard a connection that errored, so the next call reconnects."""
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def list_states(self, running_refs: set[str], in_repair: set[str]) -> list[dict] | None:
        """Placement state of rows needing reconcile, or None when Postgres is unreachable."""
        # A suspended, unhosted row with a suspended sandbox needs nothing.
        try:
            with self._cursor() as cur:
                cur.execute(
                    "SELECT id, host_pod, host_generation, phase, sandbox_ref, creator_pod, parent_id "
                    "FROM conversations "
                    "WHERE phase IS DISTINCT FROM 'Suspended' OR host_pod IS NOT NULL "
                    "OR sandbox_ref = ANY(%s) OR id = ANY(%s)",
                    (sorted(running_refs), sorted(in_repair)),
                )
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning("conversations row read failed", extra={**_C, "error": str(err)})
            return None

    def list_live(self) -> list[dict] | None:
        """Placement state of every row not parked as Suspended or Failed (the autoscale demand), or None when unreadable."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "SELECT id, host_pod, host_generation, phase, sandbox_ref, creator_pod, parent_id "
                    "FROM conversations "
                    "WHERE phase IS NULL OR phase NOT IN ('Suspended', 'Failed') OR host_pod IS NOT NULL"
                )
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning("conversations live-row read failed", extra={**_C, "error": str(err)})
            return None

    def referenced_sandboxes(self) -> set[str] | None:
        """Every sandbox_ref any row holds, or None when unreadable (the reaper must then skip)."""
        try:
            with self._cursor() as cur:
                cur.execute("SELECT DISTINCT sandbox_ref FROM conversations WHERE sandbox_ref IS NOT NULL")
                return {r[0] for r in cur.fetchall()}
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning("conversations sandbox_ref read failed", extra={**_C, "error": str(err)})
            return None

    def reapable_sandboxes(self, idle_before_ms: int, only: str | None = None) -> set[str] | None:
        """Sandbox refs whose every row is Suspended, unhosted, unstarred and idle, or None when unreadable."""
        # bool_and skips NULLs, so every term must be NULL-safe.
        try:
            with self._cursor() as cur:
                cur.execute(
                    "SELECT sandbox_ref FROM conversations "
                    "WHERE sandbox_ref IS NOT NULL AND (%s::text IS NULL OR sandbox_ref = %s) "
                    "GROUP BY sandbox_ref "
                    "HAVING bool_and(phase IS NOT DISTINCT FROM 'Suspended' AND host_pod IS NULL "
                    "AND starred IS NOT TRUE AND run_started_at IS NULL AND last_activity_at < %s)",
                    (only, only, idle_before_ms),
                )
                return {r[0] for r in cur.fetchall()}
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning("conversations reapable read failed", extra={**_C, "error": str(err)})
            return None

    def set_phase(self, conversation_id: str, phase: str) -> bool:
        """Mirror a phase onto the row, returning True when a row was updated (a miss is not an error)."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET phase = %s WHERE id = %s",
                    (phase, conversation_id),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row phase write failed",
                extra={**_C, "conversation_id": conversation_id, "phase": phase, "error": str(err)},
            )
            return False

    def set_assignment(self, conversation_id: str, host_pod: str, generation: int) -> bool:
        """Claim a conversation for a pod at an epoch, returning True when the claim won; the generation condition is what keeps ownership monotonic against a stale controller."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = %s, host_generation = %s "
                    "WHERE id = %s AND %s > host_generation",
                    (host_pod, generation, conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row assignment write failed",
                extra={
                    **_C,
                    "conversation_id": conversation_id,
                    "host_pod": host_pod,
                    "generation": generation,
                    "error": str(err),
                },
            )
            return False

    def release_assignment(self, conversation_id: str, generation: int) -> bool:
        """Clear host_pod at the current epoch, leaving host_generation as the high-water mark so a stale controller cannot detach a newer assignment."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = NULL "
                    "WHERE id = %s AND %s >= host_generation AND host_pod IS NOT NULL",
                    (conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row release failed",
                extra={**_C, "conversation_id": conversation_id, "error": str(err)},
            )
            return False

    def close(self) -> None:
        self._drop()


def from_env(connect=None) -> ConversationRows | None:
    """Build a writer from the environment, or None when no database is configured."""
    dsn = dsn_from_env()
    if not dsn:
        logger.error("no agent_host DSN configured — the controller cannot run without the conversations rows", extra=_C)
        return None
    return ConversationRows(dsn, connect=connect)
