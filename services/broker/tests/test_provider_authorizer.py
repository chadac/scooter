"""ProviderAuthorizer: the custom-authz hook for content-dependent decisions
(RED-FIRST — see todo/docs/EXTENSIBLE_BROKER.md).

Some providers' permission unit is a constraint over request CONTENT the core
can't interpret from a scope triple: AWS (an IAM policy document) and email (a
recipient allow-list). Such a provider ships a ProviderAuthorizer whose
authorize() returns an AuthzResult(decision, scope, summary, detail). The core
still owns audit + the approval interrupt; the provider only supplies judgment +
a human render, and an optional on_approved() side-effect.

This pins the hook's CONTRACT with a small email-shaped example authorizer. AWS
being re-expressed as the first real ProviderAuthorizer is covered by the AWS
tests once it's ported.
"""

from __future__ import annotations

from broker.core.policy import Decision
from broker.core.authz_provider import ProviderAuthorizer, AuthzResult, InboundRequest
from broker.core.types import Identity


def _identity() -> Identity:
    return Identity(
        conversation_id="conv-1",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-1",
    )


class EmailAuthorizer:
    """~The reference: an email provider that restricts send-to addresses. The
    deployer's policy (allowed_domains / external posture) is PASSED IN, not owned
    by the provider."""

    async def authorize(self, identity: Identity, req: InboundRequest, policy: dict) -> AuthzResult:
        import json

        recipients = json.loads(req.body or b"{}").get("to", [])
        allowed = set(policy.get("allowed_domains", []))
        domains = {r.split("@")[-1] for r in recipients}
        if domains - allowed:
            # Off allow-list.
            external = policy.get("external", "deny")
            decision = Decision.REQUIRE_APPROVAL if external == "require-approval" else Decision.DENY
            return AuthzResult(
                decision=decision,
                scope="email:send:external",
                summary=f"Send email to {', '.join(recipients)} (external)",
                detail={"recipients": recipients},
            )
        return AuthzResult(
            decision=Decision.ALLOW,
            scope="email:send:internal",
            summary=f"Send email to {', '.join(recipients)}",
            detail={"recipients": recipients},
        )


def _req(to: list[str]) -> InboundRequest:
    import json

    return InboundRequest(method="POST", path="/send", body=json.dumps({"to": to}).encode())


def test_email_authorizer_is_a_provider_authorizer():
    assert isinstance(EmailAuthorizer(), ProviderAuthorizer)


async def test_internal_recipient_allowed():
    a = EmailAuthorizer()
    res = await a.authorize(_identity(), _req(["bob@mycompany.com"]), {"allowed_domains": ["mycompany.com"]})
    assert res.decision is Decision.ALLOW
    assert res.detail == {"recipients": ["bob@mycompany.com"]}


async def test_external_recipient_requires_approval_when_configured():
    a = EmailAuthorizer()
    res = await a.authorize(
        _identity(),
        _req(["jane@partner.com"]),
        {"allowed_domains": ["mycompany.com"], "external": "require-approval"},
    )
    assert res.decision is Decision.REQUIRE_APPROVAL
    # The human-facing summary is what the approval interrupt shows.
    assert "jane@partner.com" in res.summary
    assert res.scope == "email:send:external"


async def test_external_recipient_denied_by_default():
    a = EmailAuthorizer()
    res = await a.authorize(_identity(), _req(["x@evil.com"]), {"allowed_domains": ["mycompany.com"]})
    assert res.decision is Decision.DENY


def test_authzresult_carries_no_secret_fields():
    fields = set(AuthzResult.__dataclass_fields__)
    assert "detail" in fields and "summary" in fields and "scope" in fields
    for forbidden in ("credential", "token", "secret"):
        assert forbidden not in fields
