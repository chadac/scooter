"""Which PVs a sandbox has actually used — the preference input for placement.

Recorded when a PV is observed BOUND, not when it is reserved: a reservation that never
binds (the pod never scheduled, the conversation was deleted mid-flight) means the sandbox
wrote nothing to that volume, so calling it "its warm store" would send it back to a cold
disk and pass over a genuinely warm one.

Kept in memory rather than on the PV, for two reasons:

- An annotation is single-valued, so it only records the LAST user. X uses A, then Y uses
  A, and X's association is gone forever even though A may still hold X's builds. The
  cache keeps a set per sandbox, so X can still prefer A afterwards.
- No API round-trip on the hot path.

Losing it on restart is acceptable: affinity is a preference, not correctness. A cold
cache places by recency instead, which is a slightly worse hit rate for one reconcile
cycle — never a wrong mount, since `claimRef` is what actually enforces exclusivity.
"""

from __future__ import annotations

import threading
from collections import OrderedDict


class Affinity:
    """Sandbox → the PVs it has used, most-recent-first.

    :param per_sandbox: how many PVs to remember per sandbox. Small: the point is "did
        this sandbox ever warm that volume", and a long tail of stale entries just
        outranks genuinely-hot volumes with cold ones.
    :param max_sandboxes: cap on tracked sandboxes, evicting least-recently-recorded, so a
        long-lived controller cannot grow this without bound.
    """

    def __init__(self, per_sandbox: int = 4, max_sandboxes: int = 2048) -> None:
        self._per_sandbox = per_sandbox
        self._max_sandboxes = max_sandboxes
        self._lock = threading.Lock()
        # sandbox -> PV names, most-recent-first. OrderedDict for LRU eviction.
        self._used: OrderedDict[str, list[str]] = OrderedDict()

    def record(self, pv: str, sandbox: str) -> None:
        """Note that `sandbox` is actually using `pv` (called on a BOUND observation).

        Idempotent — the loop sees the same bound PV every pass until it is released, so
        this runs repeatedly for one binding and must not grow the entry each time.
        """
        with self._lock:
            seen = self._used.get(sandbox)
            if seen is None:
                seen = []
                self._used[sandbox] = seen
            if pv in seen:
                seen.remove(pv)
            seen.insert(0, pv)
            del seen[self._per_sandbox :]
            self._used.move_to_end(sandbox)
            while len(self._used) > self._max_sandboxes:
                self._used.popitem(last=False)

    def rank_of(self, pv: str, sandbox: str) -> int:
        """How strongly `sandbox` prefers `pv`: 0 = most recently used by it, higher =
        older, and a large sentinel when it has never used it.

        Ordinal rather than boolean so a sandbox that used A then B still prefers B over
        A — both are warm for it, but B more recently.
        """
        with self._lock:
            seen = self._used.get(sandbox)
            if not seen or pv not in seen:
                return _NO_AFFINITY
            return seen.index(pv)

    def forget_pv(self, pv: str) -> None:
        """Drop `pv` from every sandbox's history — it is gone (deleted or reaped), so
        preferring it would rank a volume that no longer exists."""
        with self._lock:
            for seen in self._used.values():
                if pv in seen:
                    seen.remove(pv)

    def forget_sandbox(self, sandbox: str) -> None:
        """Drop a sandbox's history — its conversation ended, so its preferences are dead
        weight holding volumes' names against a sandbox that will never ask again."""
        with self._lock:
            self._used.pop(sandbox, None)


# Sorts after every real rank; large enough that no plausible per_sandbox reaches it.
_NO_AFFINITY = 1 << 30
