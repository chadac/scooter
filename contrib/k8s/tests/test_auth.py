"""EKS auth: the IAM token, the assumed role, and the cluster looked up when unset."""

from __future__ import annotations

import base64
from urllib.parse import parse_qs, urlparse

import boto3
import pytest

from scooter_contrib_k8s.auth import Eks, auth_for

CA = base64.b64encode(b"-----BEGIN CERTIFICATE-----\n").decode()


class FakeEks:
    def __init__(self) -> None:
        self.described: list[str] = []

    def describe_cluster(self, name: str) -> dict:
        self.described.append(name)
        return {"cluster": {"endpoint": "https://found.eks.example", "certificateAuthority": {"data": CA}}}


class FakeAssume:
    def __init__(self, calls: list[dict]) -> None:
        self.calls = calls

    def assume_role(self, **kw) -> dict:
        self.calls.append(kw)
        return {"Credentials": {"AccessKeyId": "ASSUMED", "SecretAccessKey": "s", "SessionToken": "t"}}


class Sessions:
    """A session factory: real presigning over static keys, fake EKS and AssumeRole."""

    def __init__(self) -> None:
        self.made: list[dict] = []
        self.assumed: list[dict] = []
        self.eks = FakeEks()

    def __call__(self, **creds):
        self.made.append(creds)
        real = boto3.Session(
            aws_access_key_id=creds.get("aws_access_key_id", "BROKER"),
            aws_secret_access_key=creds.get("aws_secret_access_key", "s"),
            aws_session_token=creds.get("aws_session_token"),
        )
        outer = self

        class Session:
            def client(self, name: str, **kw):
                if name == "eks":
                    return outer.eks
                if name == "sts" and "endpoint_url" not in kw:
                    return FakeAssume(outer.assumed)
                return real.client(name, **kw)

        return Session()


def decode(token: str) -> str:
    assert token.startswith("k8s-aws-v1.")
    body = token.removeprefix("k8s-aws-v1.")
    return base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode()


async def test_token_is_a_presigned_get_caller_identity_bound_to_the_cluster():
    sessions = Sessions()
    auth = Eks({"cluster_name": "prod", "region": "eu-west-1", "endpoint": "https://prod.eks.example",
                "certificate_authority": CA}, session=sessions)
    c = await auth.configuration()
    assert c.host == "https://prod.eks.example"
    assert c.api_key_prefix == {"authorization": "Bearer"}
    url = urlparse(decode(c.api_key["authorization"]))
    q = parse_qs(url.query)
    assert url.netloc == "sts.eu-west-1.amazonaws.com"
    assert q["Action"] == ["GetCallerIdentity"]
    assert q["X-Amz-Expires"] == ["60"]
    assert "x-k8s-aws-id" in q["X-Amz-SignedHeaders"][0].split(";")
    assert q["X-Amz-Credential"][0].startswith("BROKER/")
    with open(c.ssl_ca_cert, "rb") as f:
        assert f.read() == base64.b64decode(CA)
    assert sessions.eks.described == [] and sessions.assumed == []


async def test_role_arn_signs_as_the_assumed_role():
    sessions = Sessions()
    auth = Eks({"cluster_name": "prod", "region": "us-east-1", "role_arn": "arn:aws:iam::1:role/k8s",
                "endpoint": "https://prod.eks.example", "certificate_authority": CA}, session=sessions)
    c = await auth.configuration()
    assert sessions.assumed[0]["RoleArn"] == "arn:aws:iam::1:role/k8s"
    q = parse_qs(urlparse(decode(c.api_key["authorization"])).query)
    assert q["X-Amz-Credential"][0].startswith("ASSUMED/")


async def test_endpoint_and_ca_come_from_describe_cluster_when_unset():
    sessions = Sessions()
    c = await Eks({"cluster_name": "prod", "region": "us-east-1"}, session=sessions).configuration()
    assert sessions.eks.described == ["prod"]
    assert c.host == "https://found.eks.example"


def test_eks_needs_a_cluster_and_region():
    with pytest.raises(ValueError, match="cluster_name and region"):
        auth_for({"type": "eks", "region": "us-east-1"})
    assert isinstance(auth_for({"type": "eks", "cluster_name": "p", "region": "us-east-1"}), Eks)
