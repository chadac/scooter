"""Real-boto3 IAM provisioning tests against moto (mocked AWS).

Exercises the ACTUAL IamProvisioner code path (cross-account base assume →
create policy + role with boundary → chained assume → STS creds → teardown),
not the FakeIam used by the service tests. moto stands in for AWS.
"""

import json

import pytest

moto = pytest.importorskip("moto")
boto3 = pytest.importorskip("boto3")
from moto import mock_aws  # noqa: E402

from broker.aws.iam import IamProvisioner, trust_policy_for  # noqa: E402

ACCOUNT_ID = "123456789012"
BASE_ROLE = f"arn:aws:iam::{ACCOUNT_ID}:role/agent-token-broker-base"
REGISTRY = {"dev": {"account_id": ACCOUNT_ID, "broker_role_arn": BASE_ROLE, "enabled": True}}
READ = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]}


def _seed_base_role():
    """moto requires the base role to exist before assume_role works."""
    iam = boto3.client("iam", region_name="us-east-1")
    iam.create_role(RoleName="agent-token-broker-base", AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": []}))
    # The permission boundary policy the dynamic role references.
    iam.create_policy(
        PolicyName="agent-broker-permission-boundary",
        PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}),
    )


def _provisioner():
    return IamProvisioner(
        region="us-east-1", external_id="ext-id", account_registry=REGISTRY,
        propagation_delay=0,  # no real eventual-consistency sleep
    )


def test_trust_policy_names_the_broker_principal():
    tp = trust_policy_for("arn:aws:iam::123:role/broker")
    stmt = tp["Statement"][0]
    assert stmt["Principal"]["AWS"] == "arn:aws:iam::123:role/broker"
    assert stmt["Action"] == "sts:AssumeRole"


@mock_aws
def test_create_dynamic_policy():
    _seed_base_role()
    iam = _provisioner()
    arn = iam.create_dynamic_policy(target_account="dev", request_id="req-12345678", policy_document=READ)
    assert arn.startswith(f"arn:aws:iam::{ACCOUNT_ID}:policy/agent-broker-req12345678")


@mock_aws
def test_create_dynamic_role_and_chained_assume():
    _seed_base_role()
    iam = _provisioner()
    policy_arn = iam.create_dynamic_policy(target_account="dev", request_id="req-abc", policy_document=READ)
    role_arn, creds = iam.create_dynamic_role(
        target_account="dev", request_id="req-abc", policy_arn=policy_arn,
        managed_policy_arns=[], duration_seconds=900,
    )
    assert role_arn == f"arn:aws:iam::{ACCOUNT_ID}:role/agent-broker-reqabc"
    assert creds.access_key_id and creds.session_token and creds.expires_at

    # The role exists with the permission boundary + the inline policy attached.
    raw = boto3.client("iam", region_name="us-east-1")
    role = raw.get_role(RoleName="agent-broker-reqabc")["Role"]
    assert role["PermissionsBoundary"]["PermissionsBoundaryArn"].endswith("agent-broker-permission-boundary")
    attached = raw.list_attached_role_policies(RoleName="agent-broker-reqabc")["AttachedPolicies"]
    assert any(p["PolicyArn"] == policy_arn for p in attached)


@mock_aws
def test_refresh_and_teardown():
    _seed_base_role()
    iam = _provisioner()
    policy_arn = iam.create_dynamic_policy(target_account="dev", request_id="req-x", policy_document=READ)
    role_arn, _ = iam.create_dynamic_role(
        target_account="dev", request_id="req-x", policy_arn=policy_arn, managed_policy_arns=[], duration_seconds=900,
    )
    # Refresh mints fresh creds from the live role.
    creds = iam.assume_dynamic_role(target_account="dev", role_arn=role_arn, request_id="req-x", duration_seconds=900)
    assert creds.session_token

    # Teardown removes the role (and its policy).
    assert iam.delete_dynamic_role(target_account="dev", role_arn=role_arn, policy_arn=policy_arn) is True
    raw = boto3.client("iam", region_name="us-east-1")
    with pytest.raises(raw.exceptions.NoSuchEntityException):
        raw.get_role(RoleName="agent-broker-reqx")
