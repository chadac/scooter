"""IAM provisioning — cross-account dynamic roles + chained STS credentials.

DESIGN BOILERPLATE (signatures + contracts; implementation in the Implementation
stage). Mechanics (ported from the reference):

  broker IRSA --assume--> {account}/agent-token-broker-base (ExternalId)
              --create--> dynamic policy + role (trust=broker IRSA, +boundary)
              --assume(chained)--> dynamic role --> ephemeral STS creds

All target-account operations go through the base role; the broker's own pod
credentials (IRSA) can ONLY assume `agent-token-broker-base` roles (enforced by
the broker IRSA policy). The dynamic role carries a permission BOUNDARY — the AWS
hard ceiling on any vended credential.

Account registry entry (from config): {account_id, broker_role_arn, enabled,
allowed_policy?, allowed_managed_policies?}.
"""

from __future__ import annotations

from .models import StsCredentials


class IamProvisioner:
    """Provisions/assumes/tears down dynamic IAM roles in target accounts.

    A class (vs. the reference's module functions) so the boto3 clients + config
    (region, external_id, account registry) inject cleanly and a fake can be
    substituted in tests.
    """

    def __init__(
        self,
        *,
        region: str,
        external_id: str,
        account_registry: dict[str, dict],
        sts_client_factory=None,  # injectable for tests; defaults to boto3.client("sts")
    ) -> None:
        raise NotImplementedError

    def create_dynamic_policy(self, *, target_account: str, request_id: str, policy_document: dict) -> str:
        """Create the inline managed policy for a request (eagerly, at request
        time, so policy errors surface before approval). Returns the policy ARN.
        Name: agent-broker-{safe_id}; tagged agent-token-broker=true + request-id.
        """
        raise NotImplementedError

    def create_dynamic_role(
        self,
        *,
        target_account: str,
        request_id: str,
        policy_arn: str | None,
        managed_policy_arns: list[str],
        duration_seconds: int,
    ) -> tuple[str, StsCredentials]:
        """Create the dynamic role (trust = broker IRSA principal, with the
        account's permission boundary attached), attach the inline + managed
        policies, then chained-assume it to mint STS creds. Returns
        (role_arn, credentials). Retries the final assume over AccessDenied for
        trust-policy propagation. Chained assume caps the session at 1h.
        """
        raise NotImplementedError

    def assume_dynamic_role(
        self, *, target_account: str, role_arn: str, request_id: str, duration_seconds: int,
    ) -> StsCredentials:
        """Re-assume an existing live dynamic role for fresh STS creds (the
        refresh path — no new approval needed while the role TTL holds)."""
        raise NotImplementedError

    def delete_dynamic_policy(self, *, target_account: str, policy_arn: str) -> bool:
        """Delete a policy that has no attached role (deny/revoke before a role
        was created). NoSuchEntity-tolerant."""
        raise NotImplementedError

    def delete_dynamic_role(self, *, target_account: str, role_arn: str, policy_arn: str | None) -> bool:
        """Detach inline + managed policies, delete the role, delete the inline
        policy. NoSuchEntity-tolerant. Used by expiry sweep + revoke."""
        raise NotImplementedError


def trust_policy_for(broker_principal_arn: str) -> dict:
    """The dynamic role's trust policy — only the broker IRSA principal may
    sts:AssumeRole it. (Quoted/ported from the reference.)"""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"AWS": broker_principal_arn},
                "Action": "sts:AssumeRole",
            }
        ],
    }


def safe_id(request_id: str) -> str:
    """request_id sans dashes, ≤32 chars, for IAM resource names
    (agent-broker-{safe_id})."""
    return request_id.replace("-", "")[:32]
