"""Entrypoint — the elect → reconcile loop. Only reconciles while holding the leader Lease;
otherwise idles (a standby replica). Signal-drains cleanly. Mirrors conversation-controller."""

from __future__ import annotations

import logging
import signal
import threading

from .config import Config
from .k8s import ControllerK8s
from .leader import LeaderElector
from .loop import reconcile_once
from .reconcile import PoolConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("warm-store-controller")


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(
        namespace=cfg.namespace,
        warm_job_image=cfg.warm_job_image,
        warm_golden_expr=cfg.warm_golden_expr,
        overlay_storage=cfg.overlay_storage,
        runtime_class=cfg.runtime_class,
    )
    elector = LeaderElector(cfg.namespace, cfg.lease_name, cfg.identity, cfg.lease_seconds)
    pool_cfg = PoolConfig(
        current_image_tag=cfg.current_image_tag,
        min_ready=cfg.min_ready,
        max_total=cfg.max_total,
    )
    was_leader = False
    while not stop.is_set():
        try:
            leader = elector.try_acquire_or_renew()
            if leader:
                if not was_leader:
                    logger.info("became leader (%s) — reconciling", cfg.identity)
                reconcile_once(k8s, pool_cfg)
            elif was_leader:
                logger.info("lost leadership — standing by")
            was_leader = leader
        except Exception:  # a transient k8s error must not kill the loop
            logger.exception("reconcile tick failed")
        stop.wait(cfg.reconcile_interval)


def main() -> None:
    cfg = Config.from_env()
    stop = threading.Event()

    def _drain(*_a: object) -> None:
        logger.info("signal received — draining")
        stop.set()

    signal.signal(signal.SIGTERM, _drain)
    signal.signal(signal.SIGINT, _drain)
    logger.info("warm-store-controller starting (ns=%s, tag=%s)", cfg.namespace, cfg.current_image_tag)
    run(cfg, stop)


if __name__ == "__main__":
    main()
