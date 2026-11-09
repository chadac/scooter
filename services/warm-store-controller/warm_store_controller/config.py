"""Controller configuration, read from the environment by `Config.from_env()`."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


@dataclass
class Config:
    """Runtime configuration for the warm-store controller.

    :param namespace: where Sandboxes, PVCs and Jobs live.
    :param current_image_tag: the sandbox image tag new conversations get.
    :param pool_storage_class: the Retain StorageClass pool PVs live on.
    :param min_warm: floor on the idle-PV target for the current tag.
    :param max_warm: hard cap on the idle-PV target.
    :param max_warm_jobs: warm Jobs allowed to run at once.
    :param cooldown: seconds the pool must sit above target before it shrinks.
    :param sizing_policy: `reactive` or `fixed`.
    :param sizing_window: seconds of arrivals and misses the reactive policy looks at.
    :param sizing_headroom: multiplier on expected arrivals per warm-Job lead time.
    :param max_returned: cap on idle returned PVs.
    :param returned_ttl: seconds an idle returned PV is kept.
    :param marker_retries: unreadable marker checks before a PV is retired.
    :param reserve_grace: seconds before an unused reservation is cleared.
    :param port: HTTP port for /reserve and the probes.
    :param audience: token audience /reserve callers present.
    :param allowed_subjects: usernames TokenReview must return for a caller.
    """

    namespace: str = "agent-sandbox"
    current_image_tag: str = ""
    pool_storage_class: str = ""
    min_warm: int = 1
    max_warm: int = 8
    max_warm_jobs: int = 2
    cooldown: float = 1800.0
    sizing_policy: str = "reactive"
    sizing_window: float = 900.0
    sizing_headroom: float = 1.5
    max_returned: int = 5
    returned_ttl: float = 86400.0
    marker_retries: int = 3
    reserve_grace: float = 600.0
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    runtime_class: str = ""
    user_namespace: bool = False
    imageless_pod: dict = field(default_factory=dict)
    reconcile_interval: float = 10.0
    lease_seconds: int = 30
    lease_name: str = "warm-store-controller-leader"
    identity: str = "unknown"
    port: int = 8080
    audience: str = "warm-store"
    allowed_subjects: set[str] = field(default_factory=set)

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        sandbox_image = env("SANDBOX_IMAGE", "")
        # Derived from SANDBOX_IMAGE, the ref the provisioner tags reservations with.
        from .k8s import _tag_of
        namespace = env("NAMESPACE", "agent-sandbox")
        subjects = env("WARM_STORE_ALLOWED_SUBJECTS", f"system:serviceaccount:{namespace}:agent-host")
        return cls(
            namespace=namespace,
            current_image_tag=env("SANDBOX_IMAGE_TAG", "") or _tag_of(sandbox_image),
            pool_storage_class=env("WARM_STORE_STORAGE_CLASS", ""),
            min_warm=int(env("WARM_STORE_MIN_WARM", "1")),
            max_warm=int(env("WARM_STORE_MAX_WARM", "8")),
            max_warm_jobs=int(env("WARM_STORE_MAX_WARM_JOBS", "2")),
            cooldown=float(env("WARM_STORE_COOLDOWN_SECONDS", "1800")),
            sizing_policy=env("WARM_STORE_SIZING_POLICY", "reactive"),
            sizing_window=float(env("WARM_STORE_SIZING_WINDOW_SECONDS", "900")),
            sizing_headroom=float(env("WARM_STORE_SIZING_HEADROOM", "1.5")),
            max_returned=int(env("WARM_STORE_MAX_RETURNED", "5")),
            returned_ttl=float(env("WARM_STORE_RETURNED_TTL_SECONDS", "86400")),
            marker_retries=int(env("WARM_STORE_MARKER_RETRIES", "3")),
            reserve_grace=float(env("WARM_STORE_RESERVE_GRACE_SECONDS", "600")),
            warm_job_image=sandbox_image,
            warm_golden_expr=env("WARM_STORE_GOLDEN_EXPR", ""),
            overlay_storage=env("WARM_STORE_STORAGE", "20Gi"),
            runtime_class=env("SANDBOX_RUNTIME_CLASS", ""),
            user_namespace=env("SANDBOX_USER_NAMESPACE", "") == "1",
            imageless_pod=json.loads(env("SANDBOX_IMAGELESS_POD", "") or "{}"),
            reconcile_interval=float(env("RECONCILE_INTERVAL_SECONDS", "10")),
            lease_seconds=int(env("LEASE_DURATION_SECONDS", "30")),
            lease_name=env("LEASE_NAME", "warm-store-controller-leader"),
            identity=env("POD_NAME", "unknown"),
            port=int(env("PORT", "8080")),
            audience=env("WARM_STORE_AUDIENCE", "warm-store"),
            allowed_subjects={s.strip() for s in subjects.split(",") if s.strip()},
        )
