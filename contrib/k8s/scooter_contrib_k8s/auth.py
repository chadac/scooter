"""How the broker authenticates to a cluster: one ClusterAuth per `auth.type`.

A new method (GKE workload identity, say) is one class here plus its Nix option.
"""

from __future__ import annotations

import asyncio
import base64
import os
import tempfile
from typing import Any, Callable, Protocol

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


class Eks:
    """An EKS cluster over IAM, signed with the broker's own AWS credentials.

    The endpoint and CA come from the spec, else eks:DescribeCluster.
    """

    #: EKS accepts a token for 15 minutes.
    ttl: float | None = 10 * 60

    def __init__(self, spec: dict, session: Callable[..., Any] | None = None) -> None:
        self._cluster = spec.get("cluster_name") or ""
        self._region = spec.get("region") or ""
        if not self._cluster or not self._region:
            raise ValueError("eks auth needs cluster_name and region")
        self._role_arn = spec.get("role_arn") or ""
        self._endpoint = spec.get("endpoint") or ""
        self._ca = spec.get("certificate_authority") or ""
        self._new_session = session or _boto_session

    async def configuration(self) -> client.Configuration:
        return await asyncio.to_thread(self._build)

    def _build(self) -> client.Configuration:
        session = self._session()
        endpoint, ca = self._endpoint, self._ca
        if not endpoint or not ca:
            found = session.client("eks", region_name=self._region).describe_cluster(name=self._cluster)["cluster"]
            endpoint = endpoint or found["endpoint"]
            ca = ca or found["certificateAuthority"]["data"]
        c = client.Configuration()
        c.host = endpoint
        c.ssl_ca_cert = _write_ca(self._cluster, ca)
        c.api_key = {"authorization": self.token(session)}
        c.api_key_prefix = {"authorization": "Bearer"}
        return c

    def _session(self) -> Any:
        session = self._new_session()
        if not self._role_arn:
            return session
        creds = session.client("sts", region_name=self._region).assume_role(
            RoleArn=self._role_arn, RoleSessionName="scooter-broker-k8s",
        )["Credentials"]
        return self._new_session(
            aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )

    def token(self, session: Any) -> str:
        """The `k8s-aws-v1.` bearer token EKS accepts for this cluster."""
        sts = session.client("sts", region_name=self._region,
                             endpoint_url=f"https://sts.{self._region}.amazonaws.com")

        def bind_to_cluster(request: Any, **_: Any) -> None:
            request.headers["x-k8s-aws-id"] = self._cluster

        sts.meta.events.register("before-sign.sts.GetCallerIdentity", bind_to_cluster)
        url = sts.generate_presigned_url("get_caller_identity", ExpiresIn=60, HttpMethod="GET")
        return "k8s-aws-v1." + base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def _boto_session(**creds: str) -> Any:
    import boto3

    return boto3.Session(**creds)


def _write_ca(cluster: str, data: str) -> str:
    """The base64 CA bundle as a file, since the client takes a path."""
    path = os.path.join(tempfile.gettempdir(), f"scooter-k8s-{cluster}-ca.crt")
    fd, tmp = tempfile.mkstemp(dir=tempfile.gettempdir())
    with os.fdopen(fd, "wb") as f:
        f.write(base64.b64decode(data))
    os.replace(tmp, path)
    return path


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
    "eks": Eks,
}


def auth_for(spec: dict) -> ClusterAuth:
    kind = spec.get("type", "")
    if kind not in PROVIDERS:
        raise ValueError(f"unknown cluster auth type {kind!r}")
    return PROVIDERS[kind](spec)
