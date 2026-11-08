"""How the broker authenticates to a cluster: one ClusterAuth per `auth.type`.

A new method (EKS IAM, GKE workload identity) is one class here plus its Nix option.
"""

from __future__ import annotations

import os
import tempfile
from typing import Callable, Protocol

import yaml
from kubernetes import client, config


class ClusterAuth(Protocol):
    #: Seconds a built client stays valid; None means forever.
    ttl: float | None

    async def configuration(self) -> client.Configuration: ...


class InCluster:
    """The broker pod's own ServiceAccount; the loader re-reads the rotated token."""

    ttl: float | None = None

    def __init__(self, spec: dict) -> None:
        pass

    async def configuration(self) -> client.Configuration:
        c = client.Configuration()
        config.load_incluster_config(client_configuration=c)
        return c


class Kubeconfig:
    """A kubeconfig from an env var (a Secret); static tokens and certificates only."""

    ttl: float | None = None

    def __init__(self, spec: dict) -> None:
        env = spec.get("env") or ""
        raw = os.environ.get(env, "")
        if not raw:
            raise ValueError(f"kubeconfig env {env or '(unset)'} is empty")
        self._doc = yaml.safe_load(raw)
        self._context = spec.get("context") or None
        refuse_plugins(self._doc)

    async def configuration(self) -> client.Configuration:
        c = client.Configuration()
        config.load_kube_config_from_dict(
            self._doc, context=self._context, client_configuration=c,
            persist_config=False, temp_file_path=tempfile.gettempdir(),
        )
        return c


def refuse_plugins(doc: dict) -> None:
    """ValueError when a kubeconfig user would run a binary or an auth provider."""
    for u in (doc or {}).get("users") or []:
        user = u.get("user") or {}
        for key in ("exec", "auth-provider"):
            if key in user:
                raise ValueError(f"kubeconfig user {u.get('name')!r} uses `{key}`, which the broker refuses")


PROVIDERS: dict[str, Callable[[dict], ClusterAuth]] = {
    "inCluster": InCluster,
    "kubeconfig": Kubeconfig,
}


def auth_for(spec: dict) -> ClusterAuth:
    kind = spec.get("type", "")
    if kind not in PROVIDERS:
        raise ValueError(f"unknown cluster auth type {kind!r}")
    return PROVIDERS[kind](spec)
