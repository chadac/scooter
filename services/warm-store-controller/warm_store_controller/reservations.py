"""In-flight PV reservations — closing the select-vs-observe gap.

`claimRef` makes the WRITE exclusive: a PV pre-bound to <ns>/<name> cannot be taken by
any other PVC. What it does not do is make the READ current. Between issuing the patch
and k8s reflecting the binding, the PV still lists as Available with no claimRef — so the
next reconcile pass would happily select it for a second sandbox. Only one of those wins;
the loser's PVC sits Pending on a volume it will never get.

So a PV we have chosen is withheld from every later choice until we SEE the binding.

Entries expire. Without a TTL, a controller that dies between "reserve" and "observe"
leaks that PV as permanently in-flight — invisible to the pool, never allocated, never
reclaimed. The TTL bounds that to one window: worst case we re-select a PV whose patch
did land, and claimRef rejects the loser. Leaking a volume forever is worse than a
recoverable double-select.

Leader election makes the controller single-writer, so this is in-process state, not a
distributed lock. It is still guarded: the reconcile loop and any future watch callback
can touch it from different threads.
"""

from __future__ import annotations

import threading
import time


class Reservations:
    """PV names held in-flight, each expiring after `ttl_seconds`.

    :param ttl_seconds: how long a reservation survives without confirmation. Should
        comfortably exceed a reconcile interval — long enough for the binding to become
        visible, short enough that a crash does not strand the volume for long.
    :param clock: injectable time source (tests pass a fake; the module never calls
        time.time() directly elsewhere).
    """

    def __init__(self, ttl_seconds: float = 120.0, clock=time) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._held: dict[str, float] = {}  # pv name -> expiry timestamp

    def claim(self, pv: str) -> bool:
        """ATOMICALLY take `pv` if nobody holds it. True = it is yours, go write claimRef;
        False = someone else has it in flight, pick another.

        This is the whole point of the cache: test-and-set under ONE lock. Asking
        `active()` and then reserving would be check-then-act — two callers can both pass
        the check before either writes, and both go on to patch claimRef on the same PV.
        One loses at the API, and its sandbox is left with a PVC bound to nothing.

        An EXPIRED hold is treated as free, so a controller that died mid-decision does
        not strand the volume."""
        with self._lock:
            deadline = self._held.get(pv)
            if deadline is not None and deadline > self._clock.time():
                return False
            self._held[pv] = self._clock.time() + self._ttl
            return True

    def refresh(self, pv: str) -> None:
        """Extend a hold we already own — for a PV we keep choosing because the binding
        has not landed yet, so it cannot expire out from under us mid-flight."""
        with self._lock:
            self._held[pv] = self._clock.time() + self._ttl

    def confirm(self, pv: str) -> None:
        """The PVC is realised — the PV's own claimRef now excludes it from selection, so
        the local hold is redundant. Drop it."""
        with self._lock:
            self._held.pop(pv, None)

    # Rollback and confirmation are the same operation locally (stop withholding it); they
    # differ only in what the caller does to the PV. Named separately so call sites read
    # as intent rather than as a shared primitive.
    release = confirm

    def active(self) -> set[str]:
        """PV names currently in-flight, expiring anything past its deadline.

        Read-only view, for logging/metrics and for pre-filtering candidates. NOT a
        substitute for claim(): deciding from this and then reserving is the check-then-act
        race claim() exists to close."""
        now = self._clock.time()
        with self._lock:
            expired = [pv for pv, deadline in self._held.items() if deadline <= now]
            for pv in expired:
                del self._held[pv]
            return set(self._held)

    def __len__(self) -> int:
        return len(self.active())
