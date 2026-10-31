"""Where the per-user-secrets keyring lives: a Secret only the broker reads.

Every replica must open what any other sealed, so the first creates the keyring and
the rest adopt it; a create that loses the race re-reads the winner. Rotation is
manual: add a key to the Secret and point `current` at it, and old rows still open.
"""

from __future__ import annotations

import base64
import logging

from kubernetes import client
from kubernetes.client.exceptions import ApiException

from scooter_broker_lib.user_secrets import KeyRing

logger = logging.getLogger(__name__)

NAME = "scooter-user-secrets-key"
_CURRENT = "current"


def _ring(secret: client.V1Secret) -> KeyRing:
    data = {k: base64.b64decode(v) for k, v in (secret.data or {}).items()}
    current = data.pop(_CURRENT, b"").decode().strip()
    return KeyRing(keys=data, current=current)


def load_or_create_keyring(core: client.CoreV1Api, namespace: str) -> KeyRing:
    """The deployment's keyring, created on first use."""
    for _ in range(3):
        try:
            return _ring(core.read_namespaced_secret(NAME, namespace))
        except ApiException as e:
            if e.status != 404:
                raise
        fresh = KeyRing.generate()
        data = {kid: base64.b64encode(key).decode() for kid, key in fresh.keys.items()}
        data[_CURRENT] = base64.b64encode(fresh.current.encode()).decode()
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name=NAME,
                namespace=namespace,
                labels={"app.kubernetes.io/part-of": "scooter", "app.kubernetes.io/component": "broker"},
            ),
            type="Opaque",
            data=data,
        )
        try:
            core.create_namespaced_secret(namespace, body)
        except ApiException as e:
            # Another replica created it first: adopt theirs.
            if e.status == 409:
                continue
            raise
        logger.info("user-secrets keyring created", extra={"secret": NAME})
        return fresh
    raise RuntimeError("could not settle the user-secrets keyring")
