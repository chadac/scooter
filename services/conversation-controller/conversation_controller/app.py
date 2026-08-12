"""Entrypoint — the elect → reconcile loop. Only reconciles while holding the leader
Lease; otherwise idles (a standby replica). Signal-drains cleanly."""

from __future__ import annotations

import logging
import signal
import threading

from .config import Config
from .k8s import ControllerK8s
from .leader import LeaderElector
from .loop import reconcile_once, reap_orphans

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("conversation-controller")


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(cfg.namespace)
    elector = LeaderElector(cfg.namespace, cfg.lease_name, cfg.identity, cfg.lease_seconds)
    was_leader = False
    while not stop.is_set():
        try:
            leader = elector.try_acquire_or_renew()
            if leader:
                if not was_leader:
                    logger.info("became leader (%s) — reconciling", cfg.identity)
                reconcile_once(k8s, cfg.pod_cap)
                # Reap orphaned Sandboxes (no owning Conversation) — leader-only, same tick.
                # A reaper failure must NOT abort assignment reconcile, so guard it separately.
                if cfg.reap_orphans:
                    try:
                        reap_orphans(k8s, cfg.orphan_grace_seconds)
                    except Exception:  # noqa: BLE001
                        logger.exception("orphan-reaper pass failed (will retry next tick)")
            elif was_leader:
                logger.info("lost leadership — standing by")
            was_leader = leader
        except Exception:  # a transient k8s error must not kill the loop
            logger.exception("reconcile tick failed")
        stop.wait(cfg.reconcile_interval)


def main() -> None:
    cfg = Config.from_env()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("conversation-controller starting (ns=%s cap=%d id=%s)", cfg.namespace, cfg.pod_cap, cfg.identity)
    run(cfg, stop)
    logger.info("conversation-controller stopped")


if __name__ == "__main__":
    main()
