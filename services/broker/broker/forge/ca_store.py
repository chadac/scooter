"""Where the forge CA lives: its key in a Secret only the broker reads, its public half in a ConfigMap sandboxes mount.

Every broker replica must sign with the same CAs, so the first replica creates them
and the rest adopt them; the resourceVersion-guarded replace lets exactly one replica win.
Each CA is name-constrained to the hosts it was minted for and never changes, so a
running sandbox's trust stays valid. A new host (a new GHES or self-hosted GitLab)
gets a CA of its own that sandboxes trust from their next start; a CA none of whose
hosts are wanted any more is dropped.
"""

from __future__ import annotations

import base64
import logging

from kubernetes import client
from kubernetes.client.exceptions import ApiException

from .ca import CaMaterial, ca_hosts, generate_ca, split_pem

logger = logging.getLogger(__name__)

NAME = "scooter-forge-ca"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _materials(secret: client.V1Secret) -> list[CaMaterial]:
    """The CAs in the Secret: `ca.crt` and `ca.key` are bundles in the same order."""
    data = secret.data or {}
    if "ca.crt" not in data or "ca.key" not in data:
        return []
    certs = split_pem(base64.b64decode(data["ca.crt"]))
    keys = split_pem(base64.b64decode(data["ca.key"]))
    if len(certs) != len(keys):
        return []
    return [CaMaterial(c, k) for c, k in zip(certs, keys)]


def load_or_create_cas(core: client.CoreV1Api, namespace: str, hosts: list[str]) -> list[CaMaterial]:
    """The deployment's forge CAs covering `hosts`, adding one for any uncovered host, and their public ConfigMap kept in step."""
    want = sorted(set(hosts))
    if not want:
        raise ValueError("a forge CA needs at least one host")
    for _ in range(5):
        try:
            secret = core.read_namespaced_secret(NAME, namespace)
        except ApiException as e:
            if e.status != 404:
                raise
            secret = None

        current = _materials(secret) if secret is not None else []
        kept = [ca for ca in current if set(ca_hosts(ca.cert_pem)) & set(want)]
        covered = {h for ca in kept for h in ca_hosts(ca.cert_pem)}
        missing = [h for h in want if h not in covered]
        if kept == current and not missing:
            _publish(core, namespace, current, want)
            return current

        fresh = kept + ([generate_ca(missing)] if missing else [])
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name=NAME,
                namespace=namespace,
                labels={"app.kubernetes.io/part-of": "scooter", "app.kubernetes.io/component": "forge-proxy"},
                resource_version=secret.metadata.resource_version if secret is not None else None,
            ),
            type="Opaque",
            data={
                "ca.crt": _b64(b"".join(ca.cert_pem for ca in fresh)),
                "ca.key": _b64(b"".join(ca.key_pem for ca in fresh)),
            },
        )
        try:
            if secret is None:
                core.create_namespaced_secret(namespace, body)
            else:
                core.replace_namespaced_secret(NAME, namespace, body)
        except ApiException as e:
            # Another replica won the race: adopt whatever it wrote.
            if e.status == 409:
                continue
            raise
        logger.info(
            "forge CAs updated",
            extra={"hosts": want, "added": missing, "dropped": len(current) - len(kept)},
        )
        _publish(core, namespace, fresh, want)
        return fresh
    raise RuntimeError("could not settle the forge CAs after repeated conflicts")


def _publish(core: client.CoreV1Api, namespace: str, cas: list[CaMaterial], hosts: list[str]) -> None:
    """Write the public certs and the intercepted hosts where sandboxes mount them; never the keys."""
    data = {"ca.crt": "".join(ca.cert_pem.decode() for ca in cas), "hosts": "\n".join(hosts) + "\n"}
    body = client.V1ConfigMap(
        metadata=client.V1ObjectMeta(
            name=NAME,
            namespace=namespace,
            labels={"app.kubernetes.io/part-of": "scooter", "app.kubernetes.io/component": "forge-proxy"},
        ),
        data=data,
    )
    try:
        existing = core.read_namespaced_config_map(NAME, namespace)
    except ApiException as e:
        if e.status != 404:
            raise
        try:
            core.create_namespaced_config_map(namespace, body)
        except ApiException as ce:
            if ce.status != 409:
                raise
        return
    if (existing.data or {}) != data:
        body.metadata.resource_version = existing.metadata.resource_version
        try:
            core.replace_namespaced_config_map(NAME, namespace, body)
        except ApiException as e:
            # A concurrent replica published the same CA; nothing to do.
            if e.status != 409:
                raise
