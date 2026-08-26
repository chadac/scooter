"""Entrypoint — the elect → reconcile loop. Only reconciles while holding the leader
Lease; otherwise idles (a standby replica). Signal-drains cleanly."""

from __future__ import annotations

import logging
import signal
import threading

import time

from . import metrics
from .config import Config
from .k8s import ControllerK8s
from .leader import LeaderElector
from .logging_config import configure_logging
from .loop import reconcile_once, reap_orphans, autoscale_once, AutoscaleState

logger = logging.getLogger(__name__)
# Every line from this module carries component="app"; the loop/leader/k8s modules bind
# their own. Passed on each call via extra= (the stdlib has no per-logger default fields).
_C = {"component": "app"}


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(cfg.namespace)
    elector = LeaderElector(cfg.namespace, cfg.lease_name, cfg.identity, cfg.lease_seconds)
    autoscale_state = AutoscaleState()
    # /metrics on every replica (leader or standby) so a scrape target is always up.
    metrics.serve(cfg.metrics_port, stop)
    was_leader = False
    while not stop.is_set():
        try:
            leader = elector.try_acquire_or_renew()
            if leader:
                if not was_leader:
                    logger.info("became leader", extra={**_C, "identity": cfg.identity})
                reconcile_once(k8s, cfg.pod_cap)
                # Reap orphaned Sandboxes (no owning Conversation) — leader-only, same tick.
                # A reaper failure must NOT abort assignment reconcile, so guard it separately.
                if cfg.reap_orphans:
                    try:
                        reap_orphans(k8s, cfg.orphan_grace_seconds)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "orphan-reaper pass failed",
                            extra={**_C, "will_retry_next_tick": True},
                        )
                # Autoscale the agent-host fleet to fit demand + export the metric. Leader-only
                # (single writer of replicas). Guarded so a scale failure can't abort the tick.
                if cfg.autoscale:
                    try:
                        m = autoscale_once(k8s, cfg, autoscale_state, time.monotonic())
                        metrics.update(m["demand"], m["ready_pods"], m["per_pod"], m["target"])
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "autoscale pass failed",
                            extra={**_C, "will_retry_next_tick": True},
                        )
            elif was_leader:
                logger.info("lost leadership", extra={**_C, "identity": cfg.identity})
            was_leader = leader
        except Exception:  # a transient k8s error must not kill the loop
            logger.exception("reconcile tick failed", extra=_C)
        stop.wait(cfg.reconcile_interval)


def main() -> None:
    configure_logging("conversation-controller")
    cfg = Config.from_env()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    logger.info(
        "controller starting",
        extra={**_C, "namespace": cfg.namespace, "pod_cap": cfg.pod_cap, "identity": cfg.identity},
    )
    run(cfg, stop)
    logger.info("controller stopped", extra=_C)


if __name__ == "__main__":
    main()
