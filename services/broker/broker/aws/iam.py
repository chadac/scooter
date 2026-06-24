"""IAM provisioning — cross-account dynamic roles + chained STS credentials.

Mechanics (ported from the OpenHands agent-token-broker):

  broker IRSA --assume--> {account}/agent-token-broker-base (ExternalId)
              --create--> dynamic policy + role (trust=broker IRSA, +boundary)
              --assume(chained)--> dynamic role --> ephemeral STS creds

All target-account operations go through the base role; the broker's own pod
credentials (IRSA) can ONLY assume `agent-token-broker-base` roles (enforced by
the broker IRSA policy). The dynamic role carries a permission BOUNDARY — the AWS
hard ceiling on any vended credential.

A class (vs. the reference's module functions) so the boto3 clients + config
inject cleanly and a fake/moto can be substituted in tests.
"""

from __future__ import annotations

import json
import logging
import time

from .models import StsCredentials

logger = logging.getLogger(__name__)

_CHAINED_MAX = 3600  # role-chaining caps the session at 1h


class IamProvisioner:
    def __init__(
        self,
        *,
        region: str,
        external_id: str,
        account_registry: dict[str, dict],
        sts_client_factory=None,   # injectable; () -> boto3 sts client
        iam_client_factory=None,   # injectable; (creds) -> boto3 iam client
        propagation_delay: float = 10.0,  # 0 in tests (no real IAM eventual consistency)
    ) -> None:
        self._region = region
        self._external_id = external_id
        self._registry = account_registry
        self._propagation_delay = propagation_delay
        if sts_client_factory is None:
            import boto3

            sts_client_factory = lambda: boto3.client("sts", region_name=region)  # noqa: E731
        self._sts_factory = sts_client_factory
        self._iam_factory = iam_client_factory

    # --- internal: cross-account clients -----------------------------------
    def _account(self, alias: str) -> dict:
        acct = self._registry.get(alias)
        if not acct:
            raise ValueError(f"Account '{alias}' not found in registry")
        return acct

    def _assume_base(self, alias: str, *, session: str, duration: int = 900):
        """Assume the account's base role; returns its STS credentials dict."""
        acct = self._account(alias)
        sts = self._sts_factory()
        assumed = sts.assume_role(
            RoleArn=acct["broker_role_arn"],
            RoleSessionName=session,
            ExternalId=self._external_id,
            DurationSeconds=duration,
        )
        return assumed["Credentials"]

    def _iam_for(self, alias: str):
        """An IAM client scoped to the target account (via the base role)."""
        creds = self._assume_base(alias, session="agent-broker-mgmt")
        if self._iam_factory is not None:
            return self._iam_factory(creds)
        import boto3

        return boto3.client(
            "iam",
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            region_name=self._region,
        )

    @staticmethod
    def _safe_id(request_id: str) -> str:
        return request_id.replace("-", "")[:32]

    # --- create ------------------------------------------------------------
    def create_dynamic_policy(self, *, target_account: str, request_id: str, policy_document: dict) -> str:
        iam = self._iam_for(target_account)
        name = f"agent-broker-{self._safe_id(request_id)}"
        resp = iam.create_policy(
            PolicyName=name,
            PolicyDocument=json.dumps(policy_document),
            Description=f"agent permissions broker dynamic policy for request {request_id}",
            Tags=[
                {"Key": "agent-permissions-broker", "Value": "true"},
                {"Key": "request-id", "Value": request_id},
            ],
        )
        arn = resp["Policy"]["Arn"]
        logger.info("created dynamic policy %s in %s", arn, target_account)
        return arn

    def create_dynamic_role(
        self, *, target_account, request_id, policy_arn, managed_policy_arns, duration_seconds,
    ) -> tuple[str, StsCredentials]:
        from botocore.exceptions import ClientError

        acct = self._account(target_account)
        account_id = acct["account_id"]
        safe = self._safe_id(request_id)
        role_name = f"agent-broker-{safe}"
        iam = self._iam_for(target_account)

        trust = trust_policy_for(acct["broker_role_arn"])
        boundary_arn = f"arn:aws:iam::{account_id}:policy/agent-broker-permission-boundary"
        iam.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description=f"agent permissions broker dynamic role for request {request_id}",
            MaxSessionDuration=43200,
            PermissionsBoundary=boundary_arn,
        )
        # Tag separately — iam:TagRole doesn't support the boundary condition key.
        try:
            iam.tag_role(
                RoleName=role_name,
                Tags=[{"Key": "agent-permissions-broker", "Value": "true"}, {"Key": "request-id", "Value": request_id}],
            )
        except ClientError:
            logger.warning("could not tag role %s (non-fatal)", role_name)

        role_arn = f"arn:aws:iam::{account_id}:role/{role_name}"
        if policy_arn:
            iam.attach_role_policy(RoleName=role_name, PolicyArn=policy_arn)
        for arn in managed_policy_arns or []:
            iam.attach_role_policy(RoleName=role_name, PolicyArn=arn)

        # IAM is eventually consistent — let the role + trust propagate.
        if self._propagation_delay:
            time.sleep(self._propagation_delay)
        creds = self._chained_assume(
            target_account, role_arn, session=f"agent-{safe}", duration=duration_seconds, retry=True,
        )
        return role_arn, creds

    # --- assume / refresh --------------------------------------------------
    def assume_dynamic_role(self, *, target_account, role_arn, request_id, duration_seconds) -> StsCredentials:
        safe = self._safe_id(role_arn.rsplit("/", 1)[-1])
        return self._chained_assume(
            target_account, role_arn, session=f"refresh-{safe}", duration=duration_seconds, retry=False,
        )

    def _chained_assume(self, alias: str, role_arn: str, *, session: str, duration: int, retry: bool) -> StsCredentials:
        """base-assume the account, then assume the dynamic role FROM those creds
        (role chaining → capped at 1h). Retries AccessDenied for trust propagation."""
        import boto3
        from botocore.exceptions import ClientError

        capped = min(duration, _CHAINED_MAX)
        base = self._assume_base(alias, session="agent-broker-assume", duration=capped)
        sts = boto3.client(
            "sts",
            aws_access_key_id=base["AccessKeyId"],
            aws_secret_access_key=base["SecretAccessKey"],
            aws_session_token=base["SessionToken"],
            region_name=self._region,
        )
        assumed = None
        attempts = 6 if retry else 1
        for i in range(attempts):
            try:
                assumed = sts.assume_role(RoleArn=role_arn, RoleSessionName=session, DurationSeconds=capped)
                break
            except ClientError as e:
                if retry and "AccessDenied" in str(e) and i < attempts - 1:
                    logger.info("assume_role attempt %d failed (propagation), retrying", i + 1)
                    time.sleep(5)
                else:
                    raise
        assert assumed is not None
        c = assumed["Credentials"]
        return StsCredentials(
            access_key_id=c["AccessKeyId"],
            secret_access_key=c["SecretAccessKey"],
            session_token=c["SessionToken"],
            region=self._region,
            expires_at=c["Expiration"].isoformat(),
        )

    # --- teardown ----------------------------------------------------------
    def delete_dynamic_policy(self, *, target_account: str, policy_arn: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._iam_for(target_account).delete_policy(PolicyArn=policy_arn)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchEntity":
                return True
            logger.exception("failed to delete policy %s", policy_arn)
            return False

    def delete_dynamic_role(self, *, target_account: str, role_arn: str, policy_arn: str | None) -> bool:
        from botocore.exceptions import ClientError

        role_name = role_arn.rsplit("/", 1)[-1]

        def _ignore_missing(fn):
            try:
                fn()
            except ClientError as e:
                if e.response["Error"]["Code"] != "NoSuchEntity":
                    raise

        try:
            iam = self._iam_for(target_account)
            # Detach all attached managed policies (covers inline + managed ARNs).
            try:
                attached = iam.list_attached_role_policies(RoleName=role_name).get("AttachedPolicies", [])
            except ClientError as e:
                if e.response["Error"]["Code"] == "NoSuchEntity":
                    attached = []
                else:
                    raise
            for ap in attached:
                _ignore_missing(lambda arn=ap["PolicyArn"]: iam.detach_role_policy(RoleName=role_name, PolicyArn=arn))
            _ignore_missing(lambda: iam.delete_role(RoleName=role_name))
            if policy_arn:
                _ignore_missing(lambda: iam.delete_policy(PolicyArn=policy_arn))
            return True
        except Exception:
            logger.exception("failed to delete role %s", role_arn)
            return False


def trust_policy_for(broker_principal_arn: str) -> dict:
    """The dynamic role's trust policy — only the broker IRSA principal may
    sts:AssumeRole it."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Principal": {"AWS": broker_principal_arn}, "Action": "sts:AssumeRole"}
        ],
    }


def safe_id(request_id: str) -> str:
    return request_id.replace("-", "")[:32]
