"""The AWS approval notify: broker -> agent-host POST /conversations/{id}/approvals/aws.

The call that makes the Approve window appear; transient failures are retried,
permanent ones are logged, and nothing raises.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

import httpx
import pytest

from scooter_contrib_aws import broker_provider as aws_provider


def _errors(caplog):
    """The ERROR-level records, whose values ride as record attributes set via `extra=`."""
    return [r for r in caplog.records if r.levelno >= logging.ERROR]


@dataclass
class _Risk:
    value: str = "low"


_POLICY = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]}


@dataclass
class _Req:
    """The PermissionRequest fields notify_host actually reads."""

    request_id: str = "req-abc123"
    # The broker knows the conversation only by the short id parsed from the sandbox SA name.
    conversation_id: str = "k3f9zq"
    target_account: str = "dev"
    justification: str = "read terraform state"
    policy_summary: str = "s3:GetObject on the state bucket"
    risk_level: _Risk = None
    policy_document: dict | None = None
    managed_policy_arns: tuple = ()

    def __post_init__(self):
        if self.risk_level is None:
            self.risk_level = _Risk()
        if self.policy_document is None:
            self.policy_document = _POLICY


@pytest.fixture(autouse=True)
def _fast_and_configured(monkeypatch):
    """Point the notify at a host URL and remove the backoff sleep."""
    monkeypatch.setattr(aws_provider.settings, "aws_agent_host_url", "http://agent-host:8080", raising=False)
    monkeypatch.setattr(aws_provider.settings, "aws_notify_attempts", 3, raising=False)
    monkeypatch.setattr(aws_provider.settings, "aws_notify_backoff", 0.0, raising=False)


def _mock_httpx(monkeypatch, handler):
    """Route every httpx.AsyncClient request through `handler`, recording the requests it saw."""
    seen: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request, len(seen))

    real_client = httpx.AsyncClient

    def _client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(_handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _client)
    return seen


# --- the happy path -----------------------------------------------------------

@pytest.mark.asyncio
async def test_posts_the_broker_notify_shape_to_the_short_id_url(monkeypatch):
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(202, json={"ok": True}))

    await aws_provider.notify_host(_Req())

    assert len(seen) == 1
    req = seen[0]
    # Addressed by the short id, the only handle the broker has.
    assert req.url.path == "/conversations/k3f9zq/approvals/aws"
    body = json.loads(req.read().decode())
    # Prose for the plain card, plus the structured request for the aws card.
    assert body == {
        "request_id": "req-abc123",
        "message": (
            "Scooter is requesting AWS access to dev (risk: low).\n"
            "s3:GetObject on the state bucket\n"
            "Reason: read terraform state"
        ),
        "kind": "aws.permissions",
        "data": {
            "account": "dev",
            "risk": "low",
            "justification": "read terraform state",
            "summary": "s3:GetObject on the state bucket",
            "policy_document": _POLICY,
            "managed_policy_arns": [],
            "write_actions": [],
            "requested_at": None,
            "parent_request_id": None,
            "obligations": [],
        },
    }
    # The account, risk and policy facts must still reach the human inside the rendered message.
    for fact in ("dev", "low", "s3:GetObject", "read terraform state"):
        assert fact in body["message"], f"{fact} missing from the approval prose"


@pytest.mark.asyncio
async def test_a_2xx_does_not_retry(monkeypatch):
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(202))
    await aws_provider.notify_host(_Req())
    assert len(seen) == 1, "a successful notify must be delivered exactly once"


@pytest.mark.asyncio
async def test_no_host_url_configured_is_a_silent_noop(monkeypatch):
    monkeypatch.setattr(aws_provider.settings, "aws_agent_host_url", "", raising=False)
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(202))
    await aws_provider.notify_host(_Req())
    assert seen == [], "local/dev (no host URL) must not attempt a call"


# --- transient failures are retried ------------------------------------------

@pytest.mark.asyncio
async def test_503_is_retried_then_succeeds(monkeypatch):
    """503 is what the agent-host returns when it could not activate the conversation to raise the interrupt."""
    seen = _mock_httpx(
        monkeypatch,
        lambda req, n: httpx.Response(202) if n >= 3 else httpx.Response(503, text="could not activate"),
    )
    await aws_provider.notify_host(_Req())
    assert len(seen) == 3, "a 503 must be retried until it succeeds within the budget"


@pytest.mark.asyncio
async def test_5xx_exhausts_the_budget_and_logs_an_error(monkeypatch, caplog):
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(500, text="boom"))
    with caplog.at_level(logging.ERROR):
        await aws_provider.notify_host(_Req())

    assert len(seen) == 3, "a persistent 5xx must use the whole retry budget"
    errors = _errors(caplog)
    assert errors
    assert any(getattr(r, "request_id", None) == "req-abc123" for r in errors)


@pytest.mark.asyncio
async def test_connect_error_is_retried_then_logged(monkeypatch, caplog):
    def _boom(request, n):
        raise httpx.ConnectError("connection refused", request=request)

    seen = _mock_httpx(monkeypatch, _boom)
    with caplog.at_level(logging.ERROR):
        await aws_provider.notify_host(_Req())

    assert len(seen) == 3
    errors = _errors(caplog)
    assert errors
    assert any(getattr(r, "request_id", None) == "req-abc123" for r in errors)
    # str() on an httpx transport error can be empty; format_error must still say something.
    assert all(getattr(r, "error", {}).get("message") for r in errors)


@pytest.mark.asyncio
async def test_a_notify_failure_never_raises(monkeypatch):
    """The request is already stored pending, so a notify failure must not propagate."""
    def _boom(request, n):
        raise httpx.ConnectError("down", request=request)

    _mock_httpx(monkeypatch, _boom)
    await aws_provider.notify_host(_Req())


# --- permanent failures are not retried, but are surfaced --------------------

@pytest.mark.asyncio
async def test_404_is_not_retried_and_is_logged_loudly(monkeypatch, caplog):
    """A 404 means the host does not know this conversation, which will fail identically forever."""
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(404, text="unknown conversation"))
    with caplog.at_level(logging.ERROR):
        await aws_provider.notify_host(_Req())

    assert len(seen) == 1, "a 404 must NOT be retried"
    errors = _errors(caplog)
    assert errors
    assert any(getattr(r, "status", None) == 404 for r in errors)


@pytest.mark.parametrize("status", [408, 429])
@pytest.mark.asyncio
async def test_429_and_408_are_treated_as_transient(monkeypatch, status):
    """408/429 are the two 4xx that change on a retry; parametrized because a second _mock_httpx in one test would wrap the first."""
    seen = _mock_httpx(
        monkeypatch,
        lambda req, n: httpx.Response(202) if n >= 2 else httpx.Response(status),
    )
    await aws_provider.notify_host(_Req())
    assert len(seen) == 2, f"{status} must be retried, not treated as permanent"


@pytest.mark.asyncio
async def test_sends_the_router_service_token(monkeypatch):
    monkeypatch.setattr(aws_provider, "router_headers", lambda: {"authorization": "Bearer svc-token"})
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(202))

    await aws_provider.notify_host(_Req())

    assert seen[0].headers["authorization"] == "Bearer svc-token"


# --- withdraw: dropping a superseded request's card -------------------------

@pytest.mark.asyncio
async def test_withdraw_deletes_the_request_card_on_the_short_id_url(monkeypatch):
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(200, json={"withdrawn": True}))

    await aws_provider.withdraw_host(_Req())

    assert [(r.method, r.url.path) for r in seen] == [("DELETE", "/conversations/k3f9zq/approvals/aws/req-abc123")]


@pytest.mark.asyncio
@pytest.mark.parametrize("handler", [
    lambda req, n: httpx.Response(503),
    lambda req, n: (_ for _ in ()).throw(httpx.ConnectError("refused")),
])
async def test_withdraw_never_raises_and_does_not_retry(monkeypatch, handler):
    seen = _mock_httpx(monkeypatch, handler)

    await aws_provider.withdraw_host(_Req())

    assert len(seen) == 1
