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

# Conversations per sync_phases statement. Two bind parameters each, against Postgres' 65535 limit.
_SYNC_CHUNK = 500


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

    def sync_phases(self, phases: list[tuple[str, str]]) -> int:
        """Reconcile the phase column against every CR the pass just listed. Returns rows changed.

        set_phase alone is not enough to make the column trustworthy, for two reasons that both end
        with a permanently wrong row. A conversation that existed BEFORE the controller could write
        never gets a mirror, because the controller only patches on a transition and a settled
        conversation has none — its phase stays NULL and reads as "running" forever. And row writes
        are best-effort, so any dropped one is dropped for good. This is the convergent write that
        fixes both: it runs from the listed CRs each pass, so a missed write self-heals on the next
        tick and a never-written row is backfilled on the first.

        One statement per chunk, not one per conversation: this runs every tick over the whole
        fleet. `IS DISTINCT FROM` means a steady-state pass updates zero rows (and NULL-vs-value
        compares correctly, which plain `<>` would not) — so the cost of convergence is one query
        that matches nothing.
        """
        if not phases:
            return 0
        changed = 0
        # Chunked to stay clear of Postgres' 65535 bound on bind parameters (two per pair).
        for i in range(0, len(phases), _SYNC_CHUNK):
            chunk = phases[i : i + _SYNC_CHUNK]
            values = ",".join(["(%s::text, %s::text)"] * len(chunk))
            params: list[str] = []
            for conversation_id, phase in chunk:
                params += [conversation_id, phase]
            try:
                with self._cursor() as cur:
                    cur.execute(
                        "UPDATE conversations AS c SET phase = v.phase "
                        f"FROM (VALUES {values}) AS v(id, phase) "
                        "WHERE c.id = v.id AND c.phase IS DISTINCT FROM v.phase",
                        params,
                    )
                    changed += max(cur.rowcount, 0)
            except Exception as err:  # noqa: BLE001 - best-effort by contract
                self._drop()
                logger.warning(
                    "conversations row phase sync failed",
                    extra={**_C, "conversations": len(chunk), "error": str(err)},
                )
                # Stop after a failure: the connection was just dropped, and the remaining chunks
                # would each pay a fresh connect to fail the same way. The next tick retries all.
                break
        return changed

    def set_assignment(self, conversation_id: str, host_pod: str, generation: int) -> bool:
        """Claim a conversation for a pod, at an epoch. True when the claim won.

        `WHERE %s > host_generation` is the whole point of the column, and it is not defensive
        programming — it is where the monotonicity comes from. Today the CR gets it from apiserver
        optimistic concurrency; a blind mirror would throw that away, letting a paused controller
        wake up and overwrite a newer assignment with its stale view. A leader lease does not
        prevent that (a k8s Lease is not mutual exclusion, and a paused replica still believes it
        holds one), so the database has to enforce it.

        False therefore means TWO different things — the claim lost to a newer epoch, or the row is
        gone — and neither is an error the controller can act on. The CR write next to this one is
        still authoritative; this column is not read yet.
        """
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = %s, host_generation = %s "
                    "WHERE id = %s AND %s > host_generation",
                    (host_pod, generation, conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001 - best-effort by contract
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
        """Clear placement — the row half of the CR patch that sets hostPod to null.

        host_generation is deliberately LEFT where it is. Clearing it would reset the fence to 0 and
        let any stale epoch claim the conversation next; the epoch is a high-water mark, and a
        release is not a reason to forget how far ownership has advanced.

        `>=`, not `>`: a release carries the CURRENT epoch rather than a new one, so the controller
        that legitimately owns the decision matches exactly. A stale controller holds a lower epoch
        and cannot detach a pod that has since been assigned a newer one.
        """
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = NULL "
                    "WHERE id = %s AND %s >= host_generation AND host_pod IS NOT NULL",
                    (conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001 - best-effort by contract
            self._drop()
            logger.warning(
                "conversations row release failed",
                extra={**_C, "conversation_id": conversation_id, "error": str(err)},
            )
            return False

    def sync_assignments(self, assignments: list[tuple[str, str | None, int]]) -> int:
        """Converge host_pod/host_generation on the CRs this pass listed. Returns rows changed.

        The same convergence sync_phases does, and needed for a sharper reason. Appends fence on the
        row (D3), where "no generation" means "do not write" — so a settled conversation with an
        untouched row is not merely stale, it is BLOCKED. Every assignment must therefore reach the
        row from this pass, not only from a reassignment event that may never come.

        `>=`, not `>`: this carries the CR's current epoch rather than a new one, so a controller
        holding the same epoch as the row is the current one and may refresh it. A stale controller
        holds a lower epoch and is rejected, which is the property that matters. Rows already at
        that (pod, epoch) are excluded, so a steady-state pass updates none.
        """
        if not assignments:
            return 0
        changed = 0
        for i in range(0, len(assignments), _SYNC_CHUNK):
            chunk = assignments[i : i + _SYNC_CHUNK]
            values = ",".join(["(%s::text, %s::text, %s::bigint)"] * len(chunk))
            params: list[object] = []
            for conversation_id, host_pod, generation in chunk:
                params += [conversation_id, host_pod, generation]
            try:
                with self._cursor() as cur:
                    cur.execute(
                        "UPDATE conversations AS c "
                        "SET host_pod = v.host_pod, host_generation = v.gen "
                        f"FROM (VALUES {values}) AS v(id, host_pod, gen) "
                        "WHERE c.id = v.id AND v.gen >= c.host_generation "
                        "AND (c.host_pod IS DISTINCT FROM v.host_pod OR c.host_generation <> v.gen)",
                        params,
                    )
                    changed += max(cur.rowcount, 0)
            except Exception as err:  # noqa: BLE001 - best-effort by contract
                self._drop()
                logger.warning(
                    "conversations row assignment sync failed",
                    extra={**_C, "conversations": len(chunk), "error": str(err)},
                )
                break
        return changed

    def close(self) -> None:
        self._drop()


def from_env(connect=None) -> ConversationRows | None:
    """Build a writer from the environment, or None when no database is configured."""
    dsn = dsn_from_env()
    if not dsn:
        logger.info("no agent_host DSN configured — controller will not mirror phases to the row", extra=_C)
        return None
    return ConversationRows(dsn, connect=connect)
