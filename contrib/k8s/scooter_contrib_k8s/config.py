"""k8s settings, owned by this contrib, and the cluster registry they carry."""

from __future__ import annotations

import json
from dataclasses import dataclass

from scooter_lib.settings import ScooterBaseSettings


class K8sSettings(ScooterBaseSettings):
    k8s_enabled: bool = False
    # {name: cluster}, rendered by contrib.nix from contribs.k8s.clusters.
    k8s_clusters_json: str = "{}"


@dataclass(frozen=True)
class ClusterConfig:
    name: str
    auth: dict
    default_namespace: str = "default"
    read_only: bool = False
    approvers: tuple[str, ...] = ()
    grants_enabled: bool = False
    grant_max_minutes: int = 60
    #: The user writes, exec and Secret reads run as; None means the broker.
    impersonate: str | None = None


def parse_clusters(raw: str) -> dict[str, ClusterConfig]:
    """The registry, by cluster name; ValueError on a malformed entry."""
    out: dict[str, ClusterConfig] = {}
    for name, c in json.loads(raw or "{}").items():
        auth = c.get("auth")
        if not isinstance(auth, dict) or not auth.get("type"):
            raise ValueError(f"cluster {name}: auth.type is required")
        grants = c.get("grants") or {}
        out[name] = ClusterConfig(
            name=name, auth=auth,
            default_namespace=c.get("default_namespace") or "default",
            read_only=bool(c.get("read_only", False)),
            approvers=tuple(c.get("approvers") or ()),
            grants_enabled=bool(grants.get("enable", False)),
            grant_max_minutes=int(grants.get("max_minutes", 60)),
            impersonate=c.get("impersonate") or None,
        )
    return out


settings = K8sSettings()
