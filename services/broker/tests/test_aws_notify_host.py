"""The AWS approval notify: broker -> agent-host POST /conversations/{id}/aws-request.

This is the call that makes the Approve window appear in the conversation. It had
NO test coverage, and the original implementation was:

    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(url, json=payload)

— the response was discarded, so a 404 (unknown conversation) or a 503 (the host
could not activate the conversation to raise the interrupt) disappeared with no log
line anywhere. The approval simply never appeared and nothing said why. The outer
`try/except` in PermissionService only catches EXCEPTIONS, and a non-2xx response
isn't one.

The request itself is never lost — it is stored PENDING before the notify runs, and
the agent-host re-queries /aws/pending on revive. What a dropped notify costs is the
IMMEDIATE approval window, so the transient cases are retried.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx
import pytest

from broker.providers import aws as aws_provider


@dataclass
class _Risk:
    value: str = "low"


@dataclass
class _Req:
    """The PermissionRequest fields notify_host actually reads."""

    request_id: str = "req-abc123"
    # NOTE: the broker knows the conversation ONLY by the short id parsed from the
    # sandbox SA name (core/auth.py _SA_PATTERN -> `sandbox-{shortId}`), never the
    # full thread UUID. The agent-host resolves it via getByShortId.
    conversation_id: str = "k3f9zq"
    target_account: str = "dev"
    justification: str = "read terraform state"
    policy_summary: str = "s3:GetObject on the state bucket"
    risk_level: _Risk = None  # set in __post_init__

    def __post_init__(self):
        if self.risk_level is None:
            self.risk_level = _Risk()


@pytest.fixture(autouse=True)
def _fast_and_configured(monkeypatch):
    """Point the notify at a host URL and remove the backoff sleep, so the retry
    tests assert on ATTEMPT COUNT without spending real seconds."""
    monkeypatch.setattr(aws_provider.settings, "aws_agent_host_url", "http://agent-host:8080", raising=False)
    monkeypatch.setattr(aws_provider.settings, "aws_notify_attempts", 3, raising=False)
    monkeypatch.setattr(aws_provider.settings, "aws_notify_backoff", 0.0, raising=False)


def _mock_httpx(monkeypatch, handler):
    """Route every httpx.AsyncClient request in the module under test through
    `handler` (a MockTransport callable), recording the requests it saw."""
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
    # Addressed by the SHORT id — the only handle the broker has.
    assert req.url.path == "/conversations/k3f9zq/aws-request"
    body = req.read().decode()
    for field in ("req-abc123", "dev", "low", "s3:GetObject", "read terraform state"):
        assert field in body, f"{field} missing from the notify payload"


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
    """503 is exactly what the agent-host returns when it could not activate the
    conversation to raise the interrupt — the suspended/revived case. Retrying is
    what turns a lost approval window into a delivered one."""
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
    # The decisive part: it must be VISIBLE. The old code logged nothing at all.
    assert any(r.levelno >= logging.ERROR for r in caplog.records)
    assert "req-abc123" in caplog.text


@pytest.mark.asyncio
async def test_connect_error_is_retried_then_logged(monkeypatch, caplog):
    def _boom(request, n):
        raise httpx.ConnectError("connection refused", request=request)

    seen = _mock_httpx(monkeypatch, _boom)
    with caplog.at_level(logging.ERROR):
        await aws_provider.notify_host(_Req())

    assert len(seen) == 3
    assert "req-abc123" in caplog.text


@pytest.mark.asyncio
async def test_a_notify_failure_never_raises(monkeypatch):
    """The request is already stored PENDING; a notify failure must not propagate
    (it would surface as a failed `scooter-aws request` for an approval that in fact
    exists and is answerable)."""
    def _boom(request, n):
        raise httpx.ConnectError("down", request=request)

    _mock_httpx(monkeypatch, _boom)
    await aws_provider.notify_host(_Req())  # must not raise


# --- permanent failures are NOT retried, but ARE surfaced --------------------

@pytest.mark.asyncio
async def test_404_is_not_retried_and_is_logged_loudly(monkeypatch, caplog):
    """A 404 means the host does not know this conversation — an addressing bug (the
    id-space mismatch that caused the original 'approval window never appeared'). It
    will fail identically forever, so retrying only hides it."""
    seen = _mock_httpx(monkeypatch, lambda req, n: httpx.Response(404, text="unknown conversation"))
    with caplog.at_level(logging.ERROR):
        await aws_provider.notify_host(_Req())

    assert len(seen) == 1, "a 404 must NOT be retried"
    assert any(r.levelno >= logging.ERROR for r in caplog.records)
    assert "404" in caplog.text


@pytest.mark.parametrize("status", [408, 429])
@pytest.mark.asyncio
async def test_429_and_408_are_treated_as_transient(monkeypatch, status):
    """408/429 are the two 4xx that DO change on a retry, so they're transient.
    (Parametrized rather than looped: _mock_httpx patches httpx.AsyncClient, so a
    second patch inside one test wraps the first and the attempt counter carries
    over — the loop version asserted against a stale count.)"""
    seen = _mock_httpx(
        monkeypatch,
        lambda req, n: httpx.Response(202) if n >= 2 else httpx.Response(status),
    )
    await aws_provider.notify_host(_Req())
    assert len(seen) == 2, f"{status} must be retried, not treated as permanent"
