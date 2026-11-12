"""The forge egress proxy: a CONNECT proxy that terminates TLS for forge hosts and injects the provider's credential.

A sandbox reaches it through its in-pod shim (pkgs/forge-shim), which forwards
only CONNECTs for forge hosts and adds the pod's SA token as Proxy-Authorization.
Inside the tunnel each HTTP/1.1 request is classified (git, API or other web),
checked against the provider's ForgePolicy, stripped of any client credential and
sent upstream with the real one. Anything that is not a forge host is refused:
this is not a general egress proxy, so a sandbox cannot use it to reach what the
broker can reach.
"""

from __future__ import annotations

import asyncio
import json
import logging
import ssl
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

import h11
import httpx

from scooter_broker_lib.autolink import Link, post_link
from scooter_broker_lib.forge import (
    DENY_HEADER,
    ForgeHost,
    ForgeHosts,
    ForgeRequest,
    PushHeadReader,
    classify,
    denial_message,
    enforce,
    parse_graphql_body,
)
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.logging_config import format_error

from .ca import LeafIssuer

logger = logging.getLogger(__name__)

_HEAD_LIMIT = 16 * 1024
_READ_SIZE = 64 * 1024
# A push's command list precedes its pack; past this the policy gets ref_updates=None.
_PUSH_HEAD_LIMIT = 4 * 1024 * 1024
_GRAPHQL_LIMIT = 8 * 1024 * 1024

# Never forwarded upstream: hop-by-hop headers and every client-side credential.
_DROP_REQUEST = frozenset({
    "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te",
    "trailer", "upgrade", "expect", "proxy-authorization", "proxy-authenticate",
    "authorization", "private-token", "job-token", "cookie",
})
_DROP_RESPONSE = frozenset({
    "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer",
    "upgrade", "proxy-authenticate", "set-cookie",
})


class ProxyAuthError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


Authenticator = Callable[[str], Awaitable[Identity]]


@dataclass(frozen=True)
class Route:
    provider: Provider
    forge: ForgeHosts
    host: ForgeHost


def build_routes(providers: list[Provider]) -> dict[str, Route]:
    routes: dict[str, Route] = {}
    for provider in providers:
        for transport in provider.transports:
            if not isinstance(transport, ForgeHosts):
                continue
            for host in transport.hosts:
                name = host.host.lower()
                if name in routes:
                    raise ValueError(
                        f"forge host {name!r} is claimed by both {routes[name].provider.name!r} and {provider.name!r}"
                    )
                routes[name] = Route(provider, transport, host)
    return routes


class ForgeProxy:
    def __init__(
        self,
        routes: dict[str, Route],
        issuer: LeafIssuer,
        authenticate: Authenticator,
        *,
        upstream: httpx.AsyncClient | None = None,
        agent_host_url: str = "",
        upstream_scheme: str = "https",
    ) -> None:
        self.routes = routes
        self.issuer = issuer
        self.authenticate = authenticate
        self.upstream = upstream or httpx.AsyncClient(
            timeout=httpx.Timeout(connect=15, read=600, write=600, pool=60),
            follow_redirects=False,
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
        )
        self.agent_host_url = agent_host_url
        self.upstream_scheme = upstream_scheme
        self._server: asyncio.base_events.Server | None = None

    async def start(self, host: str, port: int) -> None:
        self._server = await asyncio.start_server(self.handle, host, port, limit=_HEAD_LIMIT)
        logger.info("forge proxy listening", extra={"port": port, "hosts": sorted(self.routes)})

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.sockets[0].getsockname()[1]

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        await self.upstream.aclose()

    # -- CONNECT ---------------------------------------------------------------

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._handle(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError):
            pass
        except Exception as e:  # one bad connection must not take the listener down
            logger.warning("forge proxy connection failed", extra={"error": format_error(e)})
        finally:
            writer.close()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            return
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        if len(parts) != 3:
            return await _reply(writer, 400, "bad request line")
        method, target, _ = parts
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if method != "CONNECT":
            return await _reply(writer, 405, "the forge proxy only tunnels CONNECT")
        host, _, port = target.rpartition(":")
        host = host.strip("[]").lower()
        route = self.routes.get(host)
        if route is None or port != "443":
            return await _reply(writer, 403, f"{target} is not a forge host this proxy serves")

        auth = headers.get("proxy-authorization", "")
        if not auth.lower().startswith("bearer "):
            return await _reply(writer, 407, "missing Proxy-Authorization bearer token",
                                extra="Proxy-Authenticate: Bearer\r\n")
        try:
            identity = await self.authenticate(auth[len("bearer "):].strip())
        except ProxyAuthError as e:
            return await _reply(writer, e.status, str(e))

        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        await writer.start_tls(self.issuer.context_for(host))
        await self._serve_http(reader, writer, route, host, identity)

    # -- HTTP inside the tunnel ------------------------------------------------

    async def _serve_http(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
        route: Route, host: str, identity: Identity,
    ) -> None:
        conn = h11.Connection(h11.SERVER, max_incomplete_event_size=_HEAD_LIMIT)
        io = _H11IO(conn, reader, writer)
        while True:
            try:
                event = await io.next_event()
            except h11.RemoteProtocolError:
                await io.send_simple(400, "bad request")
                return
            if not isinstance(event, h11.Request):
                return
            keep_alive = await self._one_request(io, event, route, host, identity)
            if keep_alive:
                # h11 reports a bodiless request's end as its own EndOfMessage event; read it (and any unread body) so the client side reaches DONE.
                try:
                    async for _ in io.body():
                        pass
                except h11.RemoteProtocolError:
                    return
            if not keep_alive or conn.our_state is h11.MUST_CLOSE or conn.their_state is not h11.DONE:
                return
            try:
                conn.start_next_cycle()
            except h11.LocalProtocolError:
                return

    async def _one_request(
        self, io: "_H11IO", event: h11.Request, route: Route, host: str, identity: Identity,
    ) -> bool:
        method = event.method.decode("ascii")
        target = event.target.decode("ascii", "replace")
        if not target.startswith("/"):
            await io.send_simple(400, "origin-form request target required")
            return False
        path, _, query = target.partition("?")
        headers = [(k.decode("latin-1").lower(), v.decode("latin-1")) for k, v in event.headers]
        hmap = dict(headers)
        forge = route.forge
        c = classify(
            dialect=forge.dialect, git=route.host.git, api_prefixes=route.host.api_prefixes,
            path=path, query=query,
        )
        has_body = "transfer-encoding" in hmap or hmap.get("content-length", "0") not in ("", "0")

        # Bytes read ahead of the policy check, re-sent before the rest of the body.
        prefix: list[bytes] = []
        ref_updates = None
        graphql = graphql_body = None
        if has_body and c.kind == "git" and method == "POST" and c.git_service == "git-receive-pack":
            head = PushHeadReader(gzipped=hmap.get("content-encoding", "").lower() == "gzip")
            size = 0
            async for chunk in io.body():
                prefix.append(chunk)
                size += len(chunk)
                if head.feed(chunk) is not None or head.failed or size > _PUSH_HEAD_LIMIT:
                    break
            ref_updates = head.updates
        elif has_body and method == "POST" and c.kind == "api" and forge.dialect.is_graphql(path):
            size = 0
            async for chunk in io.body():
                prefix.append(chunk)
                size += len(chunk)
                if size > _GRAPHQL_LIMIT:
                    await io.send_simple(413, "GraphQL request too large for the forge proxy")
                    return False
            graphql_body = b"".join(prefix)
            graphql = parse_graphql_body(graphql_body)

        forge_req = ForgeRequest(
            identity=identity, provider=route.provider.name, via="forge-proxy",
            method=method, host=host, path=path, query=query, kind=c.kind,
            repo=c.repo, git_service=c.git_service, ref_updates=ref_updates, graphql=graphql,
            graphql_body=graphql_body,
        )
        decision = await enforce(route.provider.forge_policy, forge_req)
        if not decision.allowed:
            await io.send_simple(
                403, denial_message(decision),
                extra=[(DENY_HEADER, decision.reason or "denied")], json_body=True,
            )
            return False

        autolink = self._wants_autolink(forge, method, path, graphql)
        out_headers = [(k, v) for k, v in headers if k not in _DROP_REQUEST]
        if autolink:
            # The response is read as JSON, so ask for it uncompressed.
            out_headers = [(k, v) for k, v in out_headers if k != "accept-encoding"]

        async def content() -> AsyncIterator[bytes]:
            for chunk in prefix:
                yield chunk
            async for chunk in io.body():
                yield chunk

        url = httpx.URL(f"{self.upstream_scheme}://{host}{target}")
        outbound = self.upstream.build_request(
            method, url, headers=out_headers, content=content() if has_body else None,
        )
        if c.kind != "web" and route.provider.credential is not None:
            cred = await route.provider.credential.get(identity, forge_req)
            if c.kind == "git":
                forge.inject_git(outbound, cred)
            else:
                cred.inject(outbound)

        try:
            upstream = await self.upstream.send(outbound, stream=True)
        except httpx.HTTPError as e:
            logger.warning("forge upstream failed", extra={"host": host, "path": path, "error": format_error(e)})
            await io.send_simple(502, f"forge upstream {host} failed: {type(e).__name__}")
            return False

        try:
            resp_headers = [
                (k, v) for k, v in upstream.headers.multi_items() if k.lower() not in _DROP_RESPONSE
            ]
            await io.send(h11.Response(status_code=upstream.status_code, headers=resp_headers))
            body = bytearray() if autolink else None
            async for chunk in upstream.aiter_raw():
                if body is not None and len(body) < _GRAPHQL_LIMIT:
                    body += chunk
                await io.send(h11.Data(data=chunk))
            await io.send(h11.EndOfMessage())
        finally:
            await upstream.aclose()

        if body is not None and 200 <= upstream.status_code < 300 and identity.conversation_id:
            await self._autolink(
                forge, method, path, graphql, _graphql_variables(graphql_body), bytes(body), identity.conversation_id,
            )
        return True

    # -- auto-linking ----------------------------------------------------------

    @staticmethod
    def _wants_autolink(forge: ForgeHosts, method: str, path: str, graphql) -> bool:
        if graphql is not None:
            return any(
                op.type == "mutation" and any(f in forge.graphql_link_rules for f in op.fields)
                for op in graphql
            )
        rel = path.lstrip("/")
        return any(r.matches(method, rel) for r in forge.link_rules)

    async def _autolink(
        self, forge: ForgeHosts, method: str, path: str, graphql, variables: dict, body: bytes,
        conversation_id: str,
    ) -> None:
        try:
            data = json.loads(body)
            links: list[Link] = []
            if graphql is not None:
                result = data.get("data") or {}
                for name, extract in forge.graphql_link_rules.items():
                    if isinstance(result.get(name), dict):
                        link = extract(result[name], variables)
                        if link is not None:
                            links.append(link)
            else:
                rule = next(r for r in forge.link_rules if r.matches(method, path.lstrip("/")))
                link = rule.extract(data) if isinstance(data, dict) else None
                if link is not None:
                    links.append(link)
        except Exception as e:  # best-effort: never affects the proxied call
            logger.debug("forge auto-link skipped", extra={"path": path, "error": format_error(e)})
            return
        for link in links:
            if link.url:
                await post_link(self.agent_host_url, conversation_id, link)


def _graphql_variables(body: bytes | None) -> dict:
    """A single GraphQL request's variables; empty for a batch or an unreadable body."""
    try:
        payload = json.loads(body or b"")
    except ValueError:
        return {}
    variables = payload.get("variables") if isinstance(payload, dict) else None
    return variables if isinstance(variables, dict) else {}


class _H11IO:
    """An h11 server connection over an asyncio stream."""

    def __init__(self, conn: h11.Connection, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.conn = conn
        self.reader = reader
        self.writer = writer

    async def next_event(self):
        while True:
            event = self.conn.next_event()
            if event is h11.NEED_DATA:
                if self.conn.they_are_waiting_for_100_continue:
                    await self.send(h11.InformationalResponse(status_code=100, headers=[]))
                self.conn.receive_data(await self.reader.read(_READ_SIZE))
                continue
            return event

    async def body(self) -> AsyncIterator[bytes]:
        """The rest of the current request body; safe to resume after breaking out of it."""
        while self.conn.their_state is h11.SEND_BODY:
            event = await self.next_event()
            if isinstance(event, h11.Data):
                yield bytes(event.data)
            elif isinstance(event, h11.EndOfMessage):
                return
            else:
                raise h11.RemoteProtocolError("unexpected event in request body")

    async def send(self, event) -> None:
        data = self.conn.send(event)
        if data:
            self.writer.write(data)
            await self.writer.drain()

    async def send_simple(
        self, status: int, message: str, *, extra: list[tuple[str, str]] | None = None, json_body: bool = False,
    ) -> None:
        if self.conn.our_state not in (h11.IDLE, h11.SEND_RESPONSE):
            return
        payload = (json.dumps({"message": message}) if json_body else message + "\n").encode()
        headers = [
            ("content-type", "application/json" if json_body else "text/plain; charset=utf-8"),
            ("content-length", str(len(payload))),
            ("connection", "close"),
            *(extra or []),
        ]
        try:
            await self.send(h11.Response(status_code=status, headers=headers))
            await self.send(h11.Data(data=payload))
            await self.send(h11.EndOfMessage())
        except h11.LocalProtocolError:
            pass


async def _reply(writer: asyncio.StreamWriter, status: int, message: str, *, extra: str = "") -> None:
    reason = {400: "Bad Request", 403: "Forbidden", 405: "Method Not Allowed",
              407: "Proxy Authentication Required", 502: "Bad Gateway"}.get(status, "Error")
    body = (message + "\n").encode()
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n"
        f"Connection: close\r\n{extra}\r\n".encode() + body
    )
    await writer.drain()
