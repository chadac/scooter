"""MCP tools — the surface a provider contributes AGENT TOOLS through.

A contrib already owns its credential source, its routes, its webhooks handler, its
UI row and its skills. It could not own its TOOL: `github_comment` lived in the
agent-host, so enabling or disabling `contrib/github` did nothing to the agent's tool
surface, and `contrib/gitlab/default.nix` declared `ui.tools.gitlab_comment` — UI
metadata for a tool the contrib neither owned nor gated. See issue #700.

A tool declared here ships iff its provider is enabled, which is the same gate
`skills` already uses and for the same stated reason: a tool for an integration that
isn't wired teaches the agent to call something that 404s, and then to read that 404
as the feature being broken.

WHAT A TOOL GETS. Handlers take a `ToolContext` carrying the verified caller, the
provider, an upstream caller with the credential already injected, and the
conversation's links. The upstream caller is the SAME injection path `HttpProxy` uses,
so a tool and the raw proxy route for one provider cannot drift apart in how they
authenticate.

TWO INVARIANTS ARE CARRIED OVER VERBATIM from the agent-host implementation this
replaces (services/agent-host/src/agent/agentTools.ts), because both were learned the
hard way:

  * ERRORS ARE NEVER HIDDEN. `ToolResult.from_upstream` surfaces the real status and
    the upstream body, so the agent sees what it would have seen from the raw route.
    The agent used to hand-run `curl -sf`, which fails SILENTLY — and a silent failure
    is how it retried and posted duplicate Slack messages.
  * ATTACHMENT GATING. A provider's reply tool is offered only when that provider is
    actually linked to the conversation, via `gate`. An ungated reply tool is what led
    the agent to raw-curl Slack into the root channel.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:  # avoid a runtime import cycle (types imports nothing from here)
    import httpx

    from .types import Credential, Identity, Provider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# What a tool returns
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolResult:
    """An MCP tool result. One text block, plus the error flag — the shape every tool
    the agent-host exposed used, kept so the migration is a move rather than a
    redesign."""

    text: str
    is_error: bool = False

    @staticmethod
    def ok(text: str) -> "ToolResult":
        return ToolResult(text=text)

    @staticmethod
    def error(text: str) -> "ToolResult":
        return ToolResult(text=text, is_error=True)

    @staticmethod
    def from_upstream(
        response: "httpx.Response",
        *,
        success_text: str,
        ok_field_check: bool = False,
        idempotent_errors: Sequence[str] = (),
    ) -> "ToolResult":
        """Map an upstream response to a result, surfacing failures VERBATIM.

        THE "never hide an error" rule, and the single place it is enforced. The real
        status and the upstream body go to the agent unmodified: the abstraction must
        not swallow, rewrite or generic-ify an error, because the agent's recovery
        depends on the actual message (and because a hidden error gets retried, which
        for a `respond` tool means posting twice).

        `ok_field_check` additionally handles APIs that report logical failure with a
        200 — Slack's `{"ok": false, "error": "..."}`. Without it a failed Slack post
        reads as a success.

        `idempotent_errors` are logical errors that mean "the desired state already
        exists", which is SUCCESS: reacting with an emoji the message already carries
        (`already_reacted`) achieved the goal. The webhooks handler posts a 👀 before
        dispatch, so without this the agent's own ack-react always failed.
        """
        if not 200 <= response.status_code < 300:
            return ToolResult.error(
                f"Request FAILED (HTTP {response.status_code}). The service returned:\n{response.text}"
            )
        if ok_field_check:
            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict) and data.get("ok") is False:
                err = data.get("error")
                if err and err in idempotent_errors:
                    return ToolResult.ok(f"{success_text} (already done — {err}.)")
                return ToolResult.error(
                    f"The service rejected the request: {err or 'unknown error'}\n"
                    f"Full response:\n{response.text}"
                )
        return ToolResult.ok(success_text)


# ---------------------------------------------------------------------------
# What a tool is given
# ---------------------------------------------------------------------------

@runtime_checkable
class UpstreamCaller(Protocol):
    """Issue a request to the provider's upstream with its credential injected.

    The same build-request-then-`Credential.inject` path `HttpProxy` uses, so a
    provider's tool and its raw proxy route authenticate identically by construction.
    `path` is relative to the provider's upstream, with no leading slash required.
    """

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> "httpx.Response": ...


@runtime_checkable
class LinkLookup(Protocol):
    """The conversation's links, for attachment gating and inferred targets.

    Returns the agent-host's link rows (`source`, `resourceType`, `url`, `ref`,
    `title`). The broker reads these from the agent-host rather than keeping its own
    copy — the agent-host owns conversation state.
    """

    async def list(self) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class ToolContext:
    """What a tool handler and its gate are handed."""

    identity: "Identity"
    provider: "Provider"
    upstream: UpstreamCaller
    links: LinkLookup

    async def credential(self) -> "Credential":
        """The provider's resolved credential, for a tool that must hold it directly
        (rare — prefer `upstream`, which never exposes it)."""
        if self.provider.credential is None:
            raise RuntimeError(f"provider {self.provider.name!r} has no credential source")
        return await self.provider.credential.get(self.identity)


ToolHandler = Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]
ToolGate = Callable[[ToolContext], Awaitable[bool]]


# ---------------------------------------------------------------------------
# The tool declaration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class McpTool:
    """One agent tool contributed by a provider.

    `name` is FLAT and unprefixed (`github_comment`, not `github__comment`): the
    skills name these tools, and `ui/src/toolCallView.ts` matches on the tool name to
    render provider message cards. A duplicate name across two enabled providers is a
    startup error, not a silent last-one-wins — see `collect_mcp_tools`.
    """

    name: str
    description: str
    handler: ToolHandler
    # JSON Schema for the arguments object. Defaults to "no arguments".
    input_schema: dict[str, Any] = field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    # Shown by the agent/UI as the tool's human label. The UI additionally accepts
    # these as a fallback match, so renaming one is a UI-visible change.
    title: str = ""
    # ATTACHMENT GATE. Return False to leave the tool unregistered for this
    # conversation. Omitted = always offered.
    gate: ToolGate | None = None


class DuplicateToolError(RuntimeError):
    """Two enabled providers declared the same tool name."""


def collect_mcp_tools(providers: "Sequence[Provider]") -> list[tuple["Provider", McpTool]]:
    """Every enabled provider's tools, paired with the provider that owns them.

    The core's assembly rule stays one sentence — for each enabled provider, mount
    every transport's routes AND collect every transport's MCP tools — so adding a
    tool-bearing integration still never edits the core.

    A duplicate name RAISES. Two providers claiming `web_search` is the deployment
    asking an unanswerable question (which search does this cluster use?), and the
    alternative is a silent last-one-wins decided by dict ordering. The search
    contribs rely on this: they all declare `web_search`, so exactly one may be
    enabled.
    """
    collected: list[tuple["Provider", McpTool]] = []
    seen: dict[str, str] = {}
    for provider in providers:
        for transport in provider.transports:
            getter = getattr(transport, "mcp_tools", None)
            if getter is None:
                continue
            for tool in getter(provider):
                if tool.name in seen:
                    raise DuplicateToolError(
                        f"tool {tool.name!r} is declared by both {seen[tool.name]!r} and "
                        f"{provider.name!r} — exactly one provider may own a tool name. "
                        "If these are alternative implementations (e.g. two search "
                        "providers), enable only one."
                    )
                seen[tool.name] = provider.name
                collected.append((provider, tool))
    return collected
