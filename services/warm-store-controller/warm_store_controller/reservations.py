"""In-flight PV reservations — who has claimed what, and the exclusion rules.

A reservation is a PAIR: a sandbox (the claimer) and a PV (the claimee). Both directions
matter, so this class owns both rather than leaving one to the caller:

- **One PV, one sandbox.** Two sandboxes must never be handed the same volume. RWO does
  not save us — a same-node double-mount of one overlay upper is store corruption.
- **One sandbox, one PV.** A sandbox that already holds a reservation must not take a
  second. The first would be stranded: `claimRef`'d to a PVC nobody creates, withheld
  from the pool until its TTL lapses.

Why a local cache rather than asking the API. `claimRef` makes the WRITE exclusive, but
not the READ current: between issuing the patch and k8s reflecting the binding, the PV
still lists as `Available` with no `claimRef`. Deciding from that is check-then-act — two
callers both see it free, both patch, one loses, and its sandbox is left with a PVC bound
to nothing. So exclusion is decided HERE, under one lock, before anything touches the API.

Reservations expire. Without a TTL a controller that dies between claiming and observing
leaks that PV as permanently in-flight — never allocated, never reclaimed, invisible to
the pool. The TTL bounds that to one window: worst case we re-select a PV whose patch did
land, and `claimRef` rejects the loser. A recoverable double-select beats a volume leaked
forever.

Leader election makes the controller single-writer, so this is in-process state, not a
distributed lock. The mutex still matters: the reconcile loop and any future watch
callback touch it from different threads.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass


class AlreadyClaimed(RuntimeError):
    """A reservation conflicts with one that already stands.

    Raised rather than returned because both cases are caller BUGS, not conditions to
    branch on: the planner is supposed to hand out at most one PV per sandbox, and never
    the same PV twice in a pass. A silent False would let that mistake through as a quiet
    mis-placement instead of surfacing it.
    """


@dataclass(frozen=True)
class Reservation:
    """A held PV and who holds it."""

    pv: str
    sandbox: str
    expires_at: float


class Reservations:
    """In-flight (sandbox ↔ PV) reservations, each expiring after `ttl_seconds`.

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
        self._by_pv: dict[str, Reservation] = {}
        self._by_sandbox: dict[str, Reservation] = {}

    def claim(self, pv: str, sandbox: str) -> Reservation:
        """Reserve `pv` for `sandbox`. Returns the reservation; raises AlreadyClaimed if
        either side is already spoken for.

        Both checks and the write happen under ONE lock — that atomicity is the whole
        point. Checking and then writing separately lets two callers both pass before
        either commits.

        Re-claiming the SAME pair is idempotent and refreshes the deadline: a sandbox we
        keep choosing (because its binding has not landed yet) must not expire mid-flight.
        That is the only way to extend a hold, and only a caller that can name the pair it
        already owns can do it.

        EXPIRED reservations on either side read as absent, so a controller that died
        mid-decision strands neither the volume nor the sandbox.
        """
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

    def confirm(self, pv: str) -> None:
        """The PVC is realised — the PV's own claimRef now excludes it from selection, so
        the local reservation is redundant. Drop it, both directions.

        IDEMPOTENT on purpose, unlike claim(). Releasing is a converging operation: the
        loop calls this for every realised PVC on every pass, so "already released" is the
        normal steady state, not a caller error."""
        with self._lock:
            res = self._by_pv.pop(pv, None)
            if res is not None and self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

    # Rollback and confirmation are the same operation locally (stop withholding it); they
    # differ only in what the caller does to the PV. Named separately so call sites read
    # as intent rather than as a shared primitive.
    release = confirm

    def holder_of(self, pv: str) -> str | None:
        """Which sandbox holds `pv`, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_pv.get(pv)
            return res.sandbox if res else None

    def pv_for(self, sandbox: str) -> str | None:
        """Which PV `sandbox` holds, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_sandbox.get(sandbox)
            return res.pv if res else None

    def active(self) -> set[str]:
        """Reserved PV names.

        Read-only view, for logging/metrics and for pre-filtering candidates. NOT a
        substitute for claim(): deciding from this and then claiming is the check-then-act
        race claim() exists to close."""
        with self._lock:
            self._expire(self._clock.time())
            return set(self._by_pv)

    def _expire(self, now: float) -> None:
        """Drop lapsed reservations from BOTH indexes. Caller holds the lock."""
        stale = [pv for pv, res in self._by_pv.items() if res.expires_at <= now]
        for pv in stale:
            res = self._by_pv.pop(pv)
            # Clear the reverse index only if it still points at THIS reservation — the
            # sandbox may since have been given a different, live one.
            if self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

    def __len__(self) -> int:
        return len(self.active())
