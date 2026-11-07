"""Entrypoint: the elect-then-reconcile loop, which only reconciles while holding the leader Lease."""

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
from .loop import reconcile_once, reap_orphans, reap_overlays, reap_sandboxes, autoscale_once, AutoscaleState
from . import rows as conversation_rows

logger = logging.getLogger(__name__)
_C = {"component": "app"}


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(cfg.namespace)
    rows = conversation_rows.from_env()
    if rows is None:
        raise SystemExit("conversation-controller: AGENT_HOST_DB_* (or AGENT_HOST_DB_DSN) is required")
    elector = LeaderElector(cfg.namespace, cfg.lease_name, cfg.identity, cfg.lease_seconds)
    autoscale_state = AutoscaleState()
    # /metrics on every replica so a scrape target is always up.
    metrics.serve(cfg.metrics_port, stop)
    was_leader = False
    last_overlay_reap = float("-inf")
    last_sandbox_reap = float("-inf")
    while not stop.is_set():
        try:
            leader = elector.try_acquire_or_renew()
            if leader:
                if not was_leader:
                    logger.info("became leader", extra={**_C, "identity": cfg.identity})
                reconcile_once(k8s, cfg.pod_cap, rows=rows)
                # Guarded separately so a reaper failure does not abort assignment.
                if cfg.reap_orphans:
                    try:
                        reap_orphans(k8s, cfg.orphan_grace_seconds, rows)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "orphan-reaper pass failed",
                            extra={**_C, "will_retry_next_tick": True},
                        )
                # At most once a minute; retention is measured in days.
                if cfg.overlay_retention_seconds > 0 and time.monotonic() - last_overlay_reap >= 60:
                    last_overlay_reap = time.monotonic()
                    try:
                        reap_overlays(k8s, cfg.overlay_retention_seconds)
                    except Exception:  # noqa: BLE001
                        logger.exception("overlay-reaper pass failed", extra={**_C, "will_retry_next_tick": True})
                if cfg.sandbox_retention_seconds > 0 and time.monotonic() - last_sandbox_reap >= 60:
                    last_sandbox_reap = time.monotonic()
                    try:
                        reap_sandboxes(k8s, rows, cfg.sandbox_retention_seconds, int(time.time() * 1000))
                    except Exception:  # noqa: BLE001
                        logger.exception("sandbox-reaper pass failed", extra={**_C, "will_retry_next_tick": True})
                # Guarded so a scale failure does not abort the tick.
                if cfg.autoscale:
                    try:
                        m = autoscale_once(k8s, cfg, autoscale_state, time.monotonic(), rows)
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
