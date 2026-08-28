"""In-flight PV reservations: a sandbox (claimer) paired with a PV (claimee).

Exclusion is decided HERE, under one lock, before anything touches the API — `claimRef`
makes the WRITE exclusive but not the READ current, so a PV we just patched still lists
as `Available` until k8s catches up. See PR #403.

In-process state, not a distributed lock (leader election makes the controller
single-writer); the mutex guards the reconcile loop against any future watch callback.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass


class AlreadyClaimed(RuntimeError):
    """A reservation conflicts with one that already stands."""


@dataclass(frozen=True)
class Reservation:
    """A held PV and who holds it."""

    pv: str
    sandbox: str
    expires_at: float


class Reservations:
    """In-flight (sandbox ↔ PV) reservations, each expiring after `ttl_seconds`.

    :param ttl_seconds: how long a reservation survives without being released. Should
        comfortably exceed a reconcile interval — long enough for the binding to become
        visible, short enough that a crash does not strand the volume for long.
    :param clock: injectable time source (tests pass a fake; the module never calls
        time.time() directly elsewhere).
    """

    def __init__(self, ttl_seconds: float = 120.0, clock=time) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._by_pv: dict[str, Reservation] = {}
        self._by_sandbox: dict[str, Reservation] = {}

    def claim(self, pv: str, sandbox: str) -> Reservation:
        """Reserve `pv` for `sandbox`; raises AlreadyClaimed if either side is taken.

        Re-claiming the SAME pair refreshes the deadline — the only way to extend a hold,
        and only a caller naming the pair it already owns can do it. Expired reservations
        read as absent. See PR #403."""
        with self._lock:
            now = self._clock.time()
            self._expire(now)

            mine = self._by_sandbox.get(sandbox)
            if mine is not None and mine.pv != pv:
                raise AlreadyClaimed(
                    f"sandbox {sandbox!r} already holds {mine.pv!r}; cannot also claim {pv!r}"
                )

            theirs = self._by_pv.get(pv)
            if theirs is not None and theirs.sandbox != sandbox:
                raise AlreadyClaimed(
                    f"PV {pv!r} is already claimed by sandbox {theirs.sandbox!r}"
                )

            res = Reservation(pv=pv, sandbox=sandbox, expires_at=now + self._ttl)
            self._by_pv[pv] = res
            self._by_sandbox[sandbox] = res
            return res

    def release(self, pv: str) -> None:
        """Give up the reservation on `pv`, both directions — whether the PVC was realised
        or a failed write is rolling back. IDEMPOTENT, unlike claim(): the loop calls this
        for every realised PVC every pass, so "already released" is the steady state."""
        with self._lock:
            res = self._by_pv.pop(pv, None)
            if res is not None and self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

    def get_pv_owner(self, pv: str) -> str | None:
        """Which sandbox holds `pv`, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_pv.get(pv)
            return res.sandbox if res else None

    def get_pv_for_pod(self, sandbox: str) -> str | None:
        """Which PV `sandbox` holds, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_sandbox.get(sandbox)
            return res.pv if res else None

    def in_flight_reservations(self) -> set[str]:
        """Reserved PV names — a read-only view for logging and pre-filtering. NOT a
        substitute for claim(): deciding from this, then claiming, is the check-then-act
        race claim() closes."""
        with self._lock:
            self._expire(self._clock.time())
            return set(self._by_pv)

    def _expire(self, now: float) -> None:
        """Drop lapsed reservations from BOTH indexes. Caller holds the lock."""
        stale = [pv for pv, res in self._by_pv.items() if res.expires_at <= now]
        for pv in stale:
            res = self._by_pv.pop(pv)
            # Only if it still points at THIS reservation — the sandbox may since have
            # been given a different, live one. PR #403.
            if self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

