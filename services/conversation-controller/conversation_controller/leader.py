"""Leader election via a coordination.k8s.io/v1 Lease, so the controller Deployment can
run >1 replica for availability while only ONE reconciles. Minimal hand-rolled election
(the python client has no built-in leaderelection): try to acquire/renew the Lease; hold
it iff we're the current holder and it hasn't expired.

Correctness is best-effort fencing at the CONTROLLER layer (two leaders briefly would at
worst double-patch the same status idempotently — assignment is convergent). The
load-bearing single-writer guarantee for the LOG is the CR's hostPod/generation, not this
Lease; this just avoids two controllers fighting."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from kubernetes import client

from .k8s import _apis

logger = logging.getLogger("conversation-controller")


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class LeaderElector:
    """Hand-rolled leader election over a single coordination.k8s.io/v1 Lease.

    :param namespace: k8s namespace the Lease lives in (the controller's own namespace).
    :param lease_name: name of the Lease object all replicas contend for — the SAME name
        across replicas is what makes them elect ONE leader.
    :param identity: this replica's holder identity written into the Lease (the pod name
        via the downward API). The current holder == leader.
    :param lease_seconds: lease duration. A holder must renew within this window or the
        Lease is considered expired and another replica may take it. Renew cadence is the
        caller's reconcile interval, which must be comfortably < this.
    """

    namespace: str
    lease_name: str
    identity: str
    lease_seconds: int = 15

    def try_acquire_or_renew(self) -> bool:
        """Return True iff WE hold the lease after this call. Acquires if free/expired,
        renews if we already hold it, else False (someone else leads)."""
        _, _, coord = _apis()
        try:
            lease = coord.read_namespaced_lease(self.lease_name, self.namespace)
        except client.ApiException as e:
            if e.status == 404:
                return self._create()
            raise

        spec = lease.spec
        holder = spec.holder_identity
        renew = spec.renew_time
        expired = (
            renew is None
            or (_now() - renew.replace(tzinfo=timezone.utc)).total_seconds()
            > (spec.lease_duration_seconds or self.lease_seconds)
        )
        if holder == self.identity or expired:
            return self._update(lease)
        return False

    def _create(self) -> bool:
        _, _, coord = _apis()
        body = client.V1Lease(
            metadata=client.V1ObjectMeta(name=self.lease_name, namespace=self.namespace),
            spec=client.V1LeaseSpec(
                holder_identity=self.identity,
                lease_duration_seconds=self.lease_seconds,
                acquire_time=_now(),
                renew_time=_now(),
            ),
        )
        try:
            coord.create_namespaced_lease(self.namespace, body)
            logger.info("acquired lease %s as %s", self.lease_name, self.identity)
            return True
        except client.ApiException as e:
            if e.status == 409:  # someone created it first
                return False
            raise

    def _update(self, lease) -> bool:
        _, _, coord = _apis()
        acquiring = lease.spec.holder_identity != self.identity
        lease.spec.holder_identity = self.identity
        lease.spec.lease_duration_seconds = self.lease_seconds
        lease.spec.renew_time = _now()
        if acquiring:
            lease.spec.acquire_time = _now()
        try:
            coord.replace_namespaced_lease(self.lease_name, self.namespace, lease)
            if acquiring:
                logger.info("acquired lease %s as %s", self.lease_name, self.identity)
            return True
        except client.ApiException as e:
            if e.status == 409:  # lost a race — not the leader this tick
                return False
            raise
