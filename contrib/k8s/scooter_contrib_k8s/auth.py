"""How the broker authenticates to a cluster: one ClusterAuth per `auth.type`.

A new method (GKE workload identity, say) is one class here plus its Nix option.
"""

from __future__ import annotations

import asyncio
import base64
import os
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import yaml

SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"


@dataclass(frozen=True)
class Endpoint:
    """Where a cluster's API server is and how to prove who we are to it."""

    server: str
    ca_file: str = ""
    cert_file: str = ""
    key_file: str = ""
    verify: bool = True
    tls_server_name: str = ""
    token: str = ""
    # Read per call, so a rotated token takes effect.
    token_file: str = ""
    basic: str = ""

    def authorization(self) -> str:
        """The Authorization header's value; "" for client certificates alone."""
        if self.token_file:
            with open(self.token_file) as f:
                return f"Bearer {f.read().strip()}"
        if self.token:
            return f"Bearer {self.token}"
        return f"Basic {self.basic}" if self.basic else ""

    @property
    def tls_key(self) -> tuple:
        return (self.server, self.ca_file, self.cert_file, self.key_file, self.verify, self.tls_server_name)


class ClusterAuth(Protocol):
    #: Seconds a built endpoint stays valid; None means forever.
    ttl: float | None

    async def endpoint(self) -> Endpoint: ...


class InCluster:
    """The broker pod's own ServiceAccount."""

    ttl: float | None = None

    def __init__(self, spec: dict, sa_dir: str = SA_DIR) -> None:
        self._dir = sa_dir

    async def endpoint(self) -> Endpoint:
        host, port = os.environ.get("KUBERNETES_SERVICE_HOST", ""), os.environ.get("KUBERNETES_SERVICE_PORT", "")
        if not host or not port:
            raise ValueError("not running in a cluster: KUBERNETES_SERVICE_HOST is unset")
        if ":" in host:
            host = f"[{host}]"
        return Endpoint(server=f"https://{host}:{port}", ca_file=os.path.join(self._dir, "ca.crt"),
                        token_file=os.path.join(self._dir, "token"))


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

    async def endpoint(self) -> Endpoint:
        return from_kubeconfig(self._doc, self._context)


def _named(doc: dict, section: str, name: str) -> dict:
    for entry in doc.get(section) or []:
        if entry.get("name") == name:
            return entry.get(section.removesuffix("s")) or {}
    raise ValueError(f"kubeconfig has no {section.removesuffix('s')} {name!r}")


def from_kubeconfig(doc: dict, context: str | None = None) -> Endpoint:
    """The endpoint one context of a kubeconfig names; `*-data` fields become private files."""
    name = context or doc.get("current-context") or ""
    if not name:
        raise ValueError("kubeconfig names no context")
    ctx = _named(doc, "contexts", name)
    cluster = _named(doc, "clusters", ctx.get("cluster") or "")
    user = _named(doc, "users", ctx["user"]) if ctx.get("user") else {}
    server = cluster.get("server") or ""
    if not server:
        raise ValueError(f"kubeconfig cluster {ctx.get('cluster')!r} has no server")

    def file(section: dict, key: str, label: str) -> str:
        data = section.get(f"{key}-data")
        return _write_private(f"{name}-{label}", base64.b64decode(data)) if data else section.get(key) or ""

    basic = ""
    if user.get("username"):
        basic = base64.b64encode(f"{user['username']}:{user.get('password') or ''}".encode()).decode()
    return Endpoint(
        server=server, ca_file=file(cluster, "certificate-authority", "ca"),
        cert_file=file(user, "client-certificate", "cert"), key_file=file(user, "client-key", "key"),
        verify=not cluster.get("insecure-skip-tls-verify", False),
        tls_server_name=cluster.get("tls-server-name") or "",
        token=user.get("token") or "", token_file=user.get("tokenFile") or "", basic=basic,
    )


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

    async def endpoint(self) -> Endpoint:
        return await asyncio.to_thread(self._build)

    def _build(self) -> Endpoint:
        session = self._session()
        endpoint, ca = self._endpoint, self._ca
        if not endpoint or not ca:
            found = session.client("eks", region_name=self._region).describe_cluster(name=self._cluster)["cluster"]
            endpoint = endpoint or found["endpoint"]
            ca = ca or found["certificateAuthority"]["data"]
        return Endpoint(server=endpoint, ca_file=_write_private(f"eks-{self._cluster}-ca", base64.b64decode(ca)),
                        token=self.token(session))

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


def _write_private(label: str, data: bytes) -> str:
    """`data` in a file only the broker can read, since ssl takes paths."""
    path = os.path.join(tempfile.gettempdir(), f"scooter-k8s-{label}.pem")
    fd, tmp = tempfile.mkstemp(dir=tempfile.gettempdir())
    with os.fdopen(fd, "wb") as f:
        f.write(data)
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
