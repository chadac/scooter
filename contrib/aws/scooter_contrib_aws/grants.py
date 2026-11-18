"""AWS role grants as the Approvals tab lists them, and the verbs that change them.

A grant is an approved request: active while its role lives, inactive once it expired, was
revoked or was replaced. Whoever could approve the original alone may change it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from scooter_broker_lib.approvals import Approver
from scooter_broker_lib.grants import (
    ACTIVE, EXPIRED, EXTEND, PIN, REVIVE, REVOKE, REVOKED, GrantChange, GrantError, GrantVerb, GrantView,
)

from .models import PermissionRequest, RequestStatus
from .service import NotPending, PermissionService, RequestError

PRESETS = (60, 240, 480, 720, 1440)
_ENDED = {RequestStatus.EXPIRED: EXPIRED, RequestStatus.REVOKED: REVOKED, RequestStatus.SUPERSEDED: REVOKED}


def _ms(iso: str | None) -> int | None:
    if not iso:
        return None
    t = datetime.fromisoformat(iso)
    return int((t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp() * 1000)


def _when(req: PermissionRequest) -> str:
    return f"until {req.role_expires_at}" if req.role_expires_at else "until revoked"


def _principal(who: Approver) -> dict:
    return {k: v for k, v in (("id", who.id), ("email", who.email), ("name", who.name)) if v}


class AwsGrants:
    def __init__(self, service: PermissionService) -> None:
        self.service = service

    def _presets(self) -> list[int]:
        cap = self.service.role_ttl_hours * 60
        return [m for m in PRESETS if m <= cap] or [cap]

    def view(self, req: PermissionRequest) -> GrantView:
        expires = _ms(req.role_expires_at)
        live = req.status == RequestStatus.ACTIVE
        if live:
            status = ACTIVE
            verbs = [GrantVerb(REVOKE, "Revoke")]
            if expires is not None:
                verbs = [GrantVerb(EXTEND, "Extend", self._presets()), GrantVerb(PIN, "Indefinite"), *verbs]
        else:
            status = _ENDED[req.status]
            verbs = [GrantVerb(REVIVE, "Revive", self._presets())]
        ended_by = "a newer grant for this account" if req.status == RequestStatus.SUPERSEDED else None
        scope = [f"account {req.target_account}", f"{req.risk_level.value} risk"]
        scope += [line for line in req.policy_summary.splitlines() if line.strip()]
        scope += req.managed_policy_arns
        return GrantView(
            id=req.request_id, conversation_id=req.conversation_id, title=f"AWS access to {req.target_account}",
            scope=scope, status=status, granted_by=req.approved_by or "", granted_at=_ms(req.approved_at) or 0,
            expires_at=expires, verbs=verbs, parent_id=req.parent_request_id,
            ended_at=_ms(req.revoked_at), ended_by=ended_by,
        )

    @staticmethod
    def _granted(req: PermissionRequest) -> bool:
        return req.approved_at is not None and (req.status == RequestStatus.ACTIVE or req.status in _ENDED)

    async def list(self, conversation_id: str) -> list[GrantView]:
        reqs = [r for r in await self.service.list_for_conversation(conversation_id) if self._granted(r)]
        return [self.view(r) for r in sorted(reqs, key=lambda r: r.approved_at or "", reverse=True)]

    async def get(self, grant_id: str) -> GrantView | None:
        req = await self.service.get(grant_id)
        return self.view(req) if req is not None and self._granted(req) else None

    async def may_act(self, grant: GrantView, verb: str, who: Approver) -> bool:
        approver = self.service.resolve_approver(_principal(who), fallback="")
        return bool(approver) and await self.service.may_manage(request_id=grant.id, approver=approver)

    async def act(self, grant: GrantView, verb: str, who: Approver, minutes: int | None) -> GrantChange:
        approver = self.service.resolve_approver(_principal(who), fallback="")
        try:
            if verb == REVOKE:
                req = await self.service.revoke(request_id=grant.id, conversation_id=grant.conversation_id)
                return GrantChange(self.view(req), (
                    f"The user revoked your AWS access to {req.target_account} (request {req.request_id}); "
                    "ask again if you still need it."))
            if verb == REVIVE:
                req = await self.service.revive(request_id=grant.id, approver=approver, minutes=minutes or 0)
                return GrantChange(self.view(req), (
                    f"The user renewed your AWS access to {req.target_account} as request {req.request_id}, "
                    f"active {_when(req)}. `aws --profile {req.target_account}` works again."))
            until = None
            if verb == EXTEND:
                now = datetime.now(timezone.utc)
                end = datetime.fromtimestamp(grant.expires_at / 1000, timezone.utc) if grant.expires_at else now
                until = (max(now, end) + timedelta(minutes=minutes or 0)).isoformat()
            req = await self.service.set_role_expiry(request_id=grant.id, until=until)
        except NotPending as e:
            raise GrantError(e.reasons[0], 409) from None
        except RequestError as e:
            raise GrantError("; ".join(e.reasons), 409) from None
        return GrantChange(self.view(req), (
            f"The user extended your AWS access to {req.target_account} (request {req.request_id}): "
            f"it is active {_when(req)}."))

    async def revoke_conversation(self, conversation_id: str) -> int:
        return await self.service.revoke_conversation(conversation_id)
