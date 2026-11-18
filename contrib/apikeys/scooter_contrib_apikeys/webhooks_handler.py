"""The API-key endpoint: /webhooks/agent-api/v1/*, served by webhooks without a browser session.

A key from Settings → API keys arrives as `Authorization: Bearer sct_…`. The broker
verifies it, and the call is relayed to the conversation-router as the key's user
(the webhooks SA names the user in X-Scooter-User, which the router trusts from it).
Paths mirror agent-host's, so a client only swaps its base URL and auth header.

Only the routes below exist, only on conversations the key's user owns, and a key
may answer `ask_user` questions but never an approval.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from limits import parse as parse_limit
from limits.aio.storage import MemoryStorage
from limits.aio.strategies import MovingWindowRateLimiter

from scooter_lib.settings import ScooterBaseSettings
from scooter_lib.svcauth import TokenSource
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

logger = logging.getLogger(__name__)

PREFIX = "/webhooks/agent-api/v1"
QUESTIONS_KIND = "ask-user.questions"
USER_HEADER = "x-scooter-user"

VERIFY_TTL_S = 30.0
OWNER_TTL_S = 30.0
STREAM_MAX_S = 3600.0
STREAMS_PER_KEY = 8
STREAMS_PER_POD = 200
PER_KEY = parse_limit("240/minute")
PER_IP = parse_limit("600/minute")
FAILURES_PER_IP = parse_limit("20/minute")
# Fields a new conversation may set; never `owner`.
_CREATE_FIELDS = {"model", "title", "visibility"}


class ApiKeysWebhooksSettings(ScooterBaseSettings):
    apikeys_webhooks_enabled: bool = False
    broker_url: str = "http://agent-broker:8080"
    # Projected token minted for the broker's audience.
    apikeys_broker_token_path: str = "/var/run/secrets/broker/token"


@dataclass(frozen=True)
class Caller:
    user: str
    key_id: str
    scopes: tuple[str, ...]


Verify = Callable[[str, str | None], Awaitable[Caller | None]]


@dataclass
class Gateway:
    """Everything a request needs; built once per process, replaced in tests."""

    verify_remote: Verify
    upstream: httpx.AsyncClient
    upstream_headers: Callable[[], dict[str, str]]
    now: Callable[[], float] = time.monotonic
    _verified: dict[str, tuple[Caller, float]] = field(default_factory=dict)
    _owners: dict[tuple[str, str], float] = field(default_factory=dict)
    streams: dict[str, int] = field(default_factory=dict)
    limiter: MovingWindowRateLimiter = field(default_factory=lambda: MovingWindowRateLimiter(MemoryStorage()))

    async def verify(self, key: str, ip: str | None) -> Caller | None:
        """The key's caller, cached for VERIFY_TTL_S; failures are never cached."""
        digest = hashlib.sha256(key.encode()).hexdigest()
        hit = self._verified.get(digest)
        if hit and self.now() < hit[1]:
            return hit[0]
        caller = await self.verify_remote(key, ip)
        if caller is None:
            self._verified.pop(digest, None)
            return None
        if len(self._verified) > 4096:
            self._verified.clear()
        self._verified[digest] = (caller, self.now() + VERIFY_TTL_S)
        return caller

    def headers(self, caller: Caller) -> dict[str, str]:
        return {**self.upstream_headers(), USER_HEADER: caller.user}

    async def owns(self, caller: Caller, conv_id: str) -> bool:
        """Whether the caller owns `conv_id`, read as the caller so visibility applies too."""
        hit = self._owners.get((caller.user, conv_id))
        if hit and self.now() < hit:
            return True
        resp = await self.upstream.get(f"/conversations/{conv_id}", headers=self.headers(caller))
        if resp.status_code != 200 or resp.json().get("owner") != caller.user:
            return False
        if len(self._owners) > 4096:
            self._owners.clear()
        self._owners[(caller.user, conv_id)] = self.now() + OWNER_TTL_S
        return True


_bearer = HTTPBearer(auto_error=False)
_gateway: Gateway | None = None


def gateway() -> Gateway:
    if _gateway is None:
        raise HTTPException(status_code=404, detail="Not Found")
    return _gateway


def _ip(request: Request) -> str | None:
    """The client as the ingress saw it: the last X-Forwarded-For hop it appended."""
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    if hops:
        return hops[-1]
    return request.client.host if request.client else None


async def _caller(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    gw: Gateway = Depends(gateway),
) -> Caller:
    ip = _ip(request) or "unknown"
    if not await gw.limiter.test(FAILURES_PER_IP, "fail", ip) or not await gw.limiter.hit(PER_IP, "ip", ip):
        raise HTTPException(status_code=429, detail="too many requests")
    caller = await gw.verify(creds.credentials, ip) if creds else None
    if caller is None:
        await gw.limiter.hit(FAILURES_PER_IP, "fail", ip)
        raise HTTPException(status_code=401, detail="invalid API key", headers={"WWW-Authenticate": "Bearer"})
    if not await gw.limiter.hit(PER_KEY, "key", caller.key_id):
        raise HTTPException(status_code=429, detail="too many requests")
    request.state.key = creds.credentials
    logger.info("api key request", extra={"key_id": caller.key_id, "user": caller.user,
                                          "method": request.method, "route": request.url.path})
    return caller


def _scope(name: str):
    async def need(caller: Caller = Depends(_caller)) -> Caller:
        if name not in caller.scopes:
            raise HTTPException(status_code=403, detail=f"this key lacks the {name} scope")
        return caller

    return need


read = Depends(_scope("read"))
write = Depends(_scope("write"))


async def _owned(gw: Gateway, caller: Caller, conv_id: str) -> None:
    # 404, not 403, so keys can't probe for conversations.
    if not await gw.owns(caller, conv_id):
        raise HTTPException(status_code=404, detail="not found")


def _relay(resp: httpx.Response) -> Response:
    return Response(content=resp.content, status_code=resp.status_code,
                    media_type=resp.headers.get("content-type", "application/json"))


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON") from None
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    return body


async def _question_ids(gw: Gateway, caller: Caller, conv_id: str) -> set[str]:
    """The conversation's open interrupts that are `ask_user` questions."""
    resp = await gw.upstream.get(f"/conversations/{conv_id}/history", headers=gw.headers(caller))
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="could not read the conversation")
    open_: dict[str, dict] = {}
    for ev in resp.json().get("events", []):
        if ev.get("type") == "RUN_FINISHED" and (ev.get("outcome") or {}).get("type") == "interrupt":
            for intr in ev["outcome"].get("interrupts") or []:
                open_[intr.get("id")] = intr
        elif ev.get("type") == "PERMISSION_RESOLVED":
            open_.pop(ev.get("toolCallId"), None)
    return {i for i, intr in open_.items() if (intr.get("metadata") or {}).get("kind") == QUESTIONS_KIND}


router = APIRouter(prefix=PREFIX)


@router.get("/whoami")
async def whoami(caller: Caller = read, gw: Gateway = Depends(gateway)) -> Response:
    return _relay(await gw.upstream.get("/whoami", headers=gw.headers(caller)))


@router.get("/conversations")
async def list_conversations(request: Request, caller: Caller = read, gw: Gateway = Depends(gateway)) -> Response:
    resp = await gw.upstream.get("/conversations", params=request.query_params, headers=gw.headers(caller))
    if resp.status_code != 200:
        return _relay(resp)
    rows = resp.json()
    if not isinstance(rows, list):
        raise HTTPException(status_code=502, detail="unexpected conversation list")
    mine = [r for r in rows if isinstance(r, dict) and r.get("owner") == caller.user]
    return Response(content=json.dumps(mine), media_type="application/json")


@router.post("/conversations")
async def create_conversation(request: Request, caller: Caller = write, gw: Gateway = Depends(gateway)) -> Response:
    body = {k: v for k, v in (await _json_body(request)).items() if k in _CREATE_FIELDS}
    return _relay(await gw.upstream.post("/conversations", json=body, headers=gw.headers(caller)))


@router.get("/conversations/{conv_id}")
async def show(conv_id: str, request: Request, caller: Caller = read, gw: Gateway = Depends(gateway)) -> Response:
    await _owned(gw, caller, conv_id)
    return _relay(await gw.upstream.get(f"/conversations/{conv_id}", params=request.query_params,
                                        headers=gw.headers(caller)))


@router.get("/conversations/{conv_id}/history")
async def history(conv_id: str, caller: Caller = read, gw: Gateway = Depends(gateway)) -> Response:
    await _owned(gw, caller, conv_id)
    return _relay(await gw.upstream.get(f"/conversations/{conv_id}/history", headers=gw.headers(caller)))


@router.post("/conversations/{conv_id}/messages")
async def message(conv_id: str, request: Request, caller: Caller = write, gw: Gateway = Depends(gateway)) -> Response:
    await _owned(gw, caller, conv_id)
    text = (await _json_body(request)).get("text")
    if not isinstance(text, str) or not text:
        raise HTTPException(status_code=400, detail="text is required")
    return _relay(await gw.upstream.post(f"/conversations/{conv_id}/messages", json={"text": text},
                                         headers=gw.headers(caller)))


@router.get("/models")
async def models(caller: Caller = read, gw: Gateway = Depends(gateway)) -> Response:
    return _relay(await gw.upstream.get("/models", headers=gw.headers(caller)))


@router.patch("/conversations/{conv_id}/{field}")
async def edit(conv_id: str, field: str, request: Request, caller: Caller = write, gw: Gateway = Depends(gateway)) -> Response:
    """Star or retitle: one field, of the type it takes."""
    kinds = {"starred": bool, "title": str}
    value = (await _json_body(request)).get(field)
    if field not in kinds:
        raise HTTPException(status_code=404, detail="Not Found")
    if not isinstance(value, kinds[field]):
        raise HTTPException(status_code=400, detail=f"{field} must be a {kinds[field].__name__}")
    await _owned(gw, caller, conv_id)
    return _relay(await gw.upstream.patch(f"/conversations/{conv_id}/{field}", json={field: value},
                                          headers=gw.headers(caller)))


@router.post("/conversations/{conv_id}/{action}")
async def act(conv_id: str, action: str, caller: Caller = write, gw: Gateway = Depends(gateway)) -> Response:
    if action not in ("cancel", "suspend"):
        raise HTTPException(status_code=404, detail="Not Found")
    await _owned(gw, caller, conv_id)
    return _relay(await gw.upstream.post(f"/conversations/{conv_id}/{action}", headers=gw.headers(caller)))


@router.post("/agui")
async def answer(request: Request, caller: Caller = write, gw: Gateway = Depends(gateway)) -> Response:
    """Only resumes of open `ask_user` questions; never a new run, never an approval."""
    body = await _json_body(request)
    conv_id, entries = body.get("threadId"), body.get("resume")
    if set(body) != {"threadId", "resume"} or not isinstance(conv_id, str) or not isinstance(entries, list) or not entries:
        raise HTTPException(status_code=400, detail="only {threadId, resume} is accepted")
    await _owned(gw, caller, conv_id)
    questions = await _question_ids(gw, caller, conv_id)
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("interruptId") not in questions:
            logger.warning("api key tried to answer a non-question", extra={"key_id": caller.key_id, "conversation_id": conv_id})
            raise HTTPException(status_code=403, detail="an API key can answer questions only; approve in the web UI")
    return _relay(await gw.upstream.post("/agui", json={"threadId": conv_id, "resume": entries},
                                         headers=gw.headers(caller)))


@router.get("/conversations/{conv_id}/events.integrity")
async def stream(conv_id: str, request: Request, caller: Caller = read, gw: Gateway = Depends(gateway)):
    await _owned(gw, caller, conv_id)
    if sum(gw.streams.values()) >= STREAMS_PER_POD or gw.streams.get(caller.key_id, 0) >= STREAMS_PER_KEY:
        raise HTTPException(status_code=429, detail="too many open streams")
    upstream = gw.upstream.build_request(
        "GET", f"/conversations/{conv_id}/events.integrity", params=request.query_params,
        headers={**gw.headers(caller), "accept": "text/event-stream"}, timeout=httpx.Timeout(10, read=None))
    resp = await gw.upstream.send(upstream, stream=True)
    if resp.status_code != 200:
        await resp.aread()
        await resp.aclose()
        return _relay(resp)
    key, ip = request.state.key, _ip(request)
    gw.streams[caller.key_id] = gw.streams.get(caller.key_id, 0) + 1

    async def watch() -> None:
        # Returns at STREAM_MAX_S or once the key stops verifying.
        deadline = gw.now() + STREAM_MAX_S
        while gw.now() < deadline:
            await asyncio.sleep(min(VERIFY_TTL_S, max(0.0, deadline - gw.now())))
            if await gw.verify(key, ip) is None:
                logger.info("api key stream closed: key no longer valid", extra={"key_id": caller.key_id})
                return

    async def read(queue: asyncio.Queue[bytes | None]) -> None:
        try:
            async for chunk in resp.aiter_raw():
                await queue.put(chunk)
        except (httpx.StreamError, httpx.HTTPError):
            pass
        await queue.put(None)

    async def body() -> AsyncIterator[bytes]:
        queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
        reader, watcher = asyncio.create_task(read(queue)), asyncio.create_task(watch())
        try:
            while True:
                getter = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({getter, watcher}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    return
                chunk = getter.result()
                if chunk is None:
                    return
                yield chunk
        finally:
            reader.cancel()
            watcher.cancel()
            gw.streams[caller.key_id] -= 1
            if not gw.streams[caller.key_id]:
                del gw.streams[caller.key_id]
            await resp.aclose()

    # Stops nginx buffering the stream.
    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


def _broker_verifier(settings: ApiKeysWebhooksSettings) -> Verify:
    token = TokenSource(settings.apikeys_broker_token_path)
    client = httpx.AsyncClient(base_url=settings.broker_url, timeout=10)

    async def verify(key: str, ip: str | None) -> Caller | None:
        resp = await client.post("/apikeys/verify", json={"key": key, "ip": ip},
                                 headers={"authorization": f"Bearer {token.current()}"})
        if resp.status_code == 401:
            return None
        if resp.status_code != 200:
            logger.warning("api key verify failed", extra={"status": resp.status_code})
            raise HTTPException(status_code=503, detail="key verification is unavailable")
        found = resp.json()
        return Caller(found["user"], found["key_id"], tuple(found["scopes"]))

    return verify


def install(gw: Gateway | None) -> None:
    global _gateway
    _gateway = gw


@register_webhook
def apikeys() -> WebhookHandler:
    settings = ApiKeysWebhooksSettings()
    if settings.apikeys_webhooks_enabled:
        token = TokenSource(settings.agent_host_token_path)
        install(Gateway(
            verify_remote=_broker_verifier(settings),
            upstream=httpx.AsyncClient(base_url=settings.agent_host_url, timeout=30),
            upstream_headers=lambda: {"authorization": f"Bearer {token.current()}"},
        ))
    return WebhookHandler(name="apikeys", router=router, enabled=settings.apikeys_webhooks_enabled)
