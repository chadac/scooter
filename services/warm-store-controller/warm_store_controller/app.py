"""Entrypoint: serve /reserve and run passes, both only while holding the leader Lease."""

from __future__ import annotations

import logging
import signal
import threading

from .config import Config
from .janitor import UpkeepConfig
from .k8s import ControllerK8s
from .leader import LeaderElector
from .logging_config import configure_logging
from .loop import PassState, reconcile_once
from .reserve import Misses, Reserver
from .server import TokenAuth, make_server
from .sizing import ActuatorConfig, FixedPolicy, ReactivePolicy, SizingPolicy

SERVICE = "warm-store-controller"
logger = logging.getLogger("app")


def make_policy(cfg: Config) -> SizingPolicy:
    if cfg.sizing_policy == "fixed":
        return FixedPolicy(cfg.min_warm)
    if cfg.sizing_policy == "reactive":
        return ReactivePolicy(cfg.min_warm, cfg.max_warm, cfg.sizing_window, cfg.sizing_headroom)
    raise ValueError(f"unknown sizing policy {cfg.sizing_policy!r}")


def run(cfg: Config, stop: threading.Event) -> None:
    k8s = ControllerK8s(
        namespace=cfg.namespace,
        pool_storage_class=cfg.pool_storage_class,
        warm_job_image=cfg.warm_job_image,
        warm_golden_expr=cfg.warm_golden_expr,
        overlay_storage=cfg.overlay_storage,
        runtime_class=cfg.runtime_class,
        user_namespace=cfg.user_namespace,
        imageless_pod=cfg.imageless_pod,
    )
    upkeep = UpkeepConfig(
        current_tag=cfg.current_image_tag,
        pool_class=cfg.pool_storage_class,
        reserve_grace=cfg.reserve_grace,
        marker_retries=cfg.marker_retries,
    )
    actuator = ActuatorConfig(
        max_warm=cfg.max_warm,
        max_warm_jobs=cfg.max_warm_jobs,
        cooldown=cfg.cooldown,
        max_returned=cfg.max_returned,
        returned_ttl=cfg.returned_ttl,
    )
    policy = make_policy(cfg)
    lock = threading.Lock()
    misses = Misses(keep_seconds=max(3600.0, cfg.sizing_window))
    reserver = Reserver(k8s, lock, misses)
    leader = threading.Event()

    server = make_server(
        cfg.port,
        leader.is_set,
        TokenAuth(k8s.review_token, cfg.audience, cfg.allowed_subjects),
        lambda sandbox, tag: reserver.reserve(sandbox, tag),
    )
    threading.Thread(target=server.serve_forever, name="http", daemon=True).start()

    elector = LeaderElector(cfg.namespace, cfg.lease_name, cfg.identity, cfg.lease_seconds)
    state = PassState()
    while not stop.is_set():
        try:
            is_leader = elector.try_acquire_or_renew()
        except Exception:  # noqa: BLE001
            logger.exception("lease renewal failed")
            is_leader = False
        if is_leader and not leader.is_set():
            logger.info("became leader", extra={"identity": cfg.identity})
            state = PassState()
        elif not is_leader and leader.is_set():
            logger.info("lost leadership, standing by", extra={"identity": cfg.identity})
        if is_leader:
            leader.set()
            try:
                reconcile_once(k8s, upkeep, policy, actuator, state, misses, lock)
            except Exception:  # a transient k8s error must not kill the loop
                logger.exception("reconcile tick failed")
        else:
            leader.clear()
        stop.wait(cfg.reconcile_interval)
    leader.clear()
    server.shutdown()


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
        extra={"namespace": cfg.namespace, "image_tag": cfg.current_image_tag, "policy": cfg.sizing_policy},
    )
    run(cfg, stop)


if __name__ == "__main__":
    main()
