"""Human approvals for a contrib: the request table, the agent-host's relay routes and the card.

A contrib declares one `Approvals`, adds it to its provider's transports, and handles
each verb:

    spawns = Approvals(contrib="handoff", kind="handoff.spawn", payload=Spawn, render=card)

    @spawns.on("approve")
    async def _(req, who) -> Decision:
        return Decision("The user approved your handoff.")

Its routes mount at /<contrib>/approvals, which `scooter.approvals.<contrib>` points
the agent-host at:

    GET  /approvals/pending?conversation_id=   pending, unexpired requests' cards
    POST /approvals/{id}/can-approve           {approver}: may this person press `gated`
    POST /approvals/{id}/{verb}                {approver}: decide once, run the handler

Rows live in the broker database's shared `approval_requests` table
(lib/sql/broker/schema.sql), each scoped to its `contrib`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from typing import Any, Awaitable, Callable, Generic, Protocol, TypeVar

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select, update

from scooter_lib.logging_config import format_error
from scooter_schema.broker import ApprovalRequests as _Row

from .autolink import router_headers
from .store import StoreConfig, open_sessions
from .types import AuthDependency, Identity, Provider, Transport

logger = logging.getLogger(__name__)

P = TypeVar("P")

DEFAULT_EXPIRY = timedelta(hours=24)

PENDING = "pending"


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Approver:
    """The person who answered, as the agent-host relays them."""

    id: str
    email: str | None = None
    name: str | None = None


@dataclass(frozen=True)
class ApprovalRequest(Generic[P]):
    id: str
    #: The id the request was raised under: the full id or the sandbox key, as the caller had it.
    conversation_id: str
    owner: str
    payload: P
    status: str
    decided_by: str | None
    created_at: int
    expires_at: int | None

    def expired(self) -> bool:
        return self.expires_at is not None and _now_ms() >= self.expires_at


@dataclass(frozen=True)
class Card:
    """What the person reads: `message` is shown as is; `data` rides along for richer cards."""

    message: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Decision:
    """A verb's outcome: `agent_message` prompts the agent; `body` joins the verb's answer."""

    agent_message: str
    body: dict[str, Any] = field(default_factory=dict)


class TooManyPending(Exception):
    """The conversation already has `max_pending` requests waiting."""


Handler = Callable[[ApprovalRequest[P], Approver], Awaitable[Decision]]


class Cards(Protocol):
    async def raise_(self, conversation_id: str, contrib: str, card: dict[str, Any]) -> None: ...

    async def withdraw(self, conversation_id: str, contrib: str, request_id: str) -> None: ...


@dataclass
class HostCards:
    """Cards on the agent-host; best effort, as re-raise and the log-based answer cover a miss."""

    url: str
    attempts: int = 3
    transport: httpx.AsyncBaseTransport | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.url.rstrip("/"), timeout=10, headers=router_headers(), transport=self.transport,
        )

    async def raise_(self, conversation_id: str, contrib: str, card: dict[str, Any]) -> None:
        extra = {"conversation_id": conversation_id, "contrib": contrib, "request_id": card["request_id"]}
        for attempt in range(self.attempts):
            try:
                async with self._client() as c:
                    r = await c.post(f"/conversations/{conversation_id}/approvals/{contrib}", json=card)
                if r.status_code < 500:
                    if r.status_code >= 300:
                        logger.warning("approval card refused", extra={**extra, "status": r.status_code})
                    return
                error = f"HTTP {r.status_code}"
            except httpx.HTTPError as e:
                error = format_error(e)
            if attempt + 1 < self.attempts:
                await asyncio.sleep(0.5 * 2**attempt)
        logger.warning("approval card failed", extra={**extra, "error": error})

    async def withdraw(self, conversation_id: str, contrib: str, request_id: str) -> None:
        try:
            async with self._client() as c:
                await c.delete(f"/conversations/{conversation_id}/approvals/{contrib}/{request_id}")
        except httpx.HTTPError as e:
            logger.warning(
                "approval card withdraw failed",
                extra={"conversation_id": conversation_id, "contrib": contrib, "request_id": request_id,
                       "error": format_error(e)},
            )


class NoCards:
    async def raise_(self, conversation_id: str, contrib: str, card: dict[str, Any]) -> None:
        return None

    async def withdraw(self, conversation_id: str, contrib: str, request_id: str) -> None:
        return None


def _approver(body: dict) -> Approver:
    a = body.get("approver")
    if isinstance(a, str):
        a = {"id": a}
    if not isinstance(a, dict) or not isinstance(a.get("id"), str) or not a["id"]:
        raise HTTPException(status_code=400, detail={"errors": ["approver required"]})
    return Approver(id=a["id"], email=a.get("email"), name=a.get("name"))


def _owns(req: ApprovalRequest, who: Approver) -> bool:
    return req.owner == who.id


@dataclass
class Approvals(Transport, Generic[P]):
    """One contrib's approvals; `payload` is a dataclass stored as JSON."""

    contrib: str
    kind: str
    payload: type[P]
    render: Callable[[ApprovalRequest[P]], Card]
    #: Who may press `gated`; the other verbs are open to anyone the agent-host shows the card.
    may_approve: Callable[[ApprovalRequest[P], Approver], bool] = _owns
    gated: str = "approve"
    #: Per conversation; None = no cap.
    max_pending: int | None = 5
    #: None = never.
    expires_after: timedelta | None = DEFAULT_EXPIRY
    name: str = "approvals"
    cards: Cards = field(default_factory=NoCards)
    _handlers: dict[str, Handler] = field(default_factory=dict, init=False, repr=False)
    _sessions: Any = field(default=None, init=False, repr=False)
    _engine: Any = field(default=None, init=False, repr=False)

    def configure(self, config: StoreConfig, cards: Cards | None = None) -> None:
        """Open the broker database and, given one, where cards are raised."""
        self._engine, self._sessions = open_sessions(config)
        if cards is not None:
            self.cards = cards

    def on(self, verb: str) -> Callable[[Handler], Handler]:
        def register(fn: Handler) -> Handler:
            self._handlers[verb] = fn
            return fn

        return register

    # --- requests -------------------------------------------------------------------

    def _ready(self):
        if self._sessions is None:
            raise HTTPException(status_code=503, detail=f"{self.contrib} approvals are not configured")
        return self._sessions

    def _request(self, row: _Row) -> ApprovalRequest[P]:
        return ApprovalRequest(
            id=row.id, conversation_id=row.conversation_id, owner=row.owner,
            payload=self.payload(**json.loads(row.payload)), status=row.status,
            decided_by=row.decided_by, created_at=row.created_at, expires_at=row.expires_at,
        )

    def card(self, req: ApprovalRequest[P]) -> dict[str, Any]:
        c = self.render(req)
        return {"request_id": req.id, "message": c.message, "kind": self.kind, "data": c.data}

    async def request(self, conversation_id: str, payload: P, *, owner: str) -> ApprovalRequest[P]:
        """Store a pending request, then raise its card; TooManyPending past `max_pending`."""
        now = _now_ms()
        expires = now + int(self.expires_after.total_seconds() * 1000) if self.expires_after is not None else None
        async with self._ready()() as s, s.begin():
            if self.max_pending is not None:
                waiting = await s.scalar(
                    select(func.count()).select_from(_Row).where(*self._open(now), _Row.conversation_id == conversation_id)
                )
                if waiting >= self.max_pending:
                    raise TooManyPending(f"this conversation already has {waiting} requests waiting for approval")
            row = _Row(
                id=str(uuid.uuid4()), contrib=self.contrib, conversation_id=conversation_id, owner=owner,
                payload=json.dumps(asdict(payload)), status=PENDING, created_at=now, expires_at=expires,
            )
            s.add(row)
        req = self._request(row)
        await self.cards.raise_(conversation_id, self.contrib, self.card(req))
        return req

    @staticmethod
    def pending_result(req: ApprovalRequest) -> dict[str, Any]:
        """What the agent's tool returns while the person decides."""
        return {
            "status": "pending_approval",
            "request_id": req.id,
            "note": "A person must approve this in the conversation. A message will tell you the outcome; do not retry.",
        }

    async def get(self, request_id: str) -> ApprovalRequest[P] | None:
        async with self._ready()() as s:
            row = await s.scalar(select(_Row).where(*self._mine(request_id)))
        return self._request(row) if row else None

    def _mine(self, request_id: str) -> tuple:
        return (_Row.id == request_id, _Row.contrib == self.contrib)

    def _open(self, now: int) -> tuple:
        return (
            _Row.contrib == self.contrib, _Row.status == PENDING,
            (_Row.expires_at.is_(None)) | (_Row.expires_at > now),
        )

    async def pending(self, *, conversation_id: str | None = None, owner: str | None = None) -> list[ApprovalRequest[P]]:
        """Unexpired pending requests, oldest first, by conversation and/or owner."""
        q = select(_Row).where(*self._open(_now_ms())).order_by(_Row.created_at)
        if conversation_id is not None:
            q = q.where(_Row.conversation_id == conversation_id)
        if owner is not None:
            q = q.where(_Row.owner == owner)
        async with self._ready()() as s:
            return [self._request(r) for r in (await s.scalars(q)).all()]

    async def _claim(self, request_id: str, status: str, decided_by: str | None) -> bool:
        """Move a pending request to `status`, exactly once."""
        async with self._ready()() as s, s.begin():
            claimed = await s.execute(
                update(_Row)
                .where(*self._mine(request_id), _Row.status == PENDING)
                .values(status=status, decided_by=decided_by, decided_at=_now_ms())
                .execution_options(synchronize_session=False)
            )
        return claimed.rowcount == 1

    async def withdraw(self, req: ApprovalRequest[P]) -> None:
        """Retire a superseded request and its card."""
        if await self._claim(req.id, "withdrawn", None):
            await self.cards.withdraw(req.conversation_id, self.contrib, req.id)

    async def _set_status(self, request_id: str, status: str) -> None:
        async with self._ready()() as s, s.begin():
            await s.execute(update(_Row).where(*self._mine(request_id)).values(status=status))

    # --- routes ---------------------------------------------------------------------

    async def answer(self, request_id: str, verb: str, who: Approver) -> dict[str, Any]:
        """Decide a request as `who`, run the verb's handler, and say what the agent hears."""
        handler = self._handlers.get(verb)
        if handler is None:
            raise HTTPException(status_code=400, detail={"errors": [f"unknown verb '{verb}'"]})
        req = await self.get(request_id)
        if req is None:
            raise HTTPException(status_code=404, detail={"errors": ["no such request"]})
        if req.status != PENDING:
            raise HTTPException(status_code=409, detail={"errors": [f"request already {req.status}"]})
        if verb == self.gated and not self.may_approve(req, who):
            raise HTTPException(status_code=403, detail={"errors": [f"{who.id} may not {verb} this request"]})
        if req.expired():
            if await self._claim(req.id, "expired", None):
                return {"status": "expired", "agent_message": (
                    f"Your {self.kind} request expired before anyone answered it, so nothing was done. "
                    "Ask again if it is still needed."
                )}
            raise HTTPException(status_code=409, detail={"errors": ["request already decided"]})
        if not await self._claim(req.id, verb, who.id):
            raise HTTPException(status_code=409, detail={"errors": ["request already decided"]})
        try:
            decision = await handler(req, who)
        except Exception as e:
            logger.exception("approval handler failed", extra={"contrib": self.contrib, "request_id": req.id, "verb": verb})
            await self._set_status(req.id, "failed")
            return {"status": "failed", "agent_message": (
                f"The user chose {verb} on your {self.kind} request, but carrying it out failed: {str(e) or type(e).__name__}"
            )}
        return {**decision.body, "status": verb, "agent_message": decision.agent_message}

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        async def approver_caller(identity: Identity = Depends(authed)) -> Identity:
            if not identity.is_approver:
                raise HTTPException(status_code=403, detail="not an approver")
            return identity

        router = APIRouter(prefix="/approvals", tags=[f"{self.contrib} approvals"],
                           dependencies=[Depends(approver_caller)])

        @router.get("/pending")
        async def pending(conversation_id: str = "") -> dict:
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            return {"requests": [self.card(r) for r in await self.pending(conversation_id=conversation_id)]}

        @router.post("/{request_id}/can-approve")
        async def can_approve(request_id: str, body: dict = Body(default={})) -> dict:
            req = await self.get(request_id)
            ok = req is not None and req.status == PENDING and not req.expired()
            # `pending: false` lets the UI say the request is gone, not that an admin must approve.
            return {"can_approve": ok and self.may_approve(req, _approver(body)), "pending": ok}

        @router.post("/{request_id}/{verb}")
        async def verb(request_id: str, verb: str, body: dict = Body(default={})) -> dict:
            return await self.answer(request_id, verb, _approver(body))

        return router
