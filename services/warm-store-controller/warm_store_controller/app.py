"""Entrypoint — the elect → reconcile loop. Only reconciles while holding the leader Lease;
otherwise idles (a standby replica). Signal-drains cleanly. Mirrors conversation-controller."""

from __future__ import annotations

import logging
import signal
import threading

from .config import Config
from .k8s import ControllerK8s
from .leader import LeaderElector
from .logging_config import configure_logging
from .loop import reconcile_once
from .reconcile import PoolConfig
from .reservations import Reservations

SERVICE = "warm-store-controller"
logger = logging.getLogger("app")


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(
        namespace=cfg.namespace,
        warm_job_image=cfg.warm_job_image,
        warm_golden_expr=cfg.warm_golden_expr,
        overlay_storage=cfg.overlay_storage,
        runtime_class=cfg.runtime_class,
        pool_storage_class=cfg.pool_storage_class,
    )
    # In-flight PV holds, owned by the loop for the process's lifetime (leader election
    # makes this single-writer). TTL well over a reconcile interval: long enough for a
    # binding to become visible, short enough that a crash cannot strand a volume.
    reservations = Reservations(ttl_seconds=max(120.0, cfg.reconcile_interval * 6))
    # sandbox -> the PV it last used, for preferential placement. Recorded when a PV is
    # seen BOUND, so a reservation that never binds leaves no trace. In-memory: losing it
    # on restart costs one cycle of hit rate, never correctness (claimRef is what enforces
    # exclusivity; this only orders candidates).
    affinity: dict[str, str] = {}
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
                    logger.info("became leader", extra={"identity": cfg.identity})
                reconcile_once(k8s, pool_cfg, reservations, affinity)
            elif was_leader:
                logger.info("lost leadership, standing by", extra={"identity": cfg.identity})
            was_leader = leader
        except Exception:  # a transient k8s error must not kill the loop
            logger.exception("reconcile tick failed")  # formatter attaches structured error
        stop.wait(cfg.reconcile_interval)


def main() -> None:
    configure_logging(SERVICE)
    cfg = Config.from_env()
    stop = threading.Event()

    def _drain(*_a: object) -> None:
        logger.info("signal received, draining")
        stop.set()

    signal.signal(signal.SIGTERM, _drain)
    signal.signal(signal.SIGINT, _drain)
    logger.info(
        "starting",
        extra={"namespace": cfg.namespace, "image_tag": cfg.current_image_tag},
    )
    run(cfg, stop)


if __name__ == "__main__":
    main()
