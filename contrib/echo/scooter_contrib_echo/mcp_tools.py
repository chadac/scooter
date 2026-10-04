"""Echo's AGENT TOOLS — the worked example of the `mcp_tools` surface.

A contrib owns its credential source, its routes, its webhooks handler, its UI row
and its skills; since issue #700 it owns its agent TOOLS too. This file is the
reference for that surface, the way `broker_provider.py` is the reference for a custom
Transport, and it is deliberately NOT the smallest thing that compiles — each tool
below demonstrates one thing a real integration needs:

  echo_say        the minimum: arguments in, a result out.
  echo_whoami     reading the VERIFIED caller. `identity.conversation_id` is the whole
                  point of #700 — it comes from a signed token or an SA name, never
                  from anything the agent sent, so a tool can trust it as the
                  conversation it is acting for.
  echo_upstream   calling an API through `ctx.upstream`, which injects the provider's
                  credential on the way out. The agent never sees the secret, exactly
                  as with the http-proxy transport — and `ToolResult.from_upstream`
                  surfaces a failure VERBATIM rather than flattening it.
  echo_attached   the ATTACHMENT GATE. Registered only when this conversation has an
                  `echo` link, so the agent is never shown a reply tool for a resource
                  that is not there. An ungated reply tool is what once sent the agent
                  raw-curling Slack into the root channel.

Loaded only in the broker image (it imports the broker surface), via the provider
factory in broker_provider.py. `contrib/echo` ships with `enable = false`, so these
tools reach a real broker only in the test/example images that turn it on.
"""

from __future__ import annotations

from typing import Any

from scooter_broker_lib.mcp import McpTool, ToolContext, ToolResult

# The provider whose links gate `echo_attached`. A real contrib uses its own source
# name here — "github", "slack" — which is what `agent-broker link add --source` records.
LINK_SOURCE = "echo"


async def _say(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    """The minimum shape: validate, act, return.

    Argument validation is the TOOL'S job. The JSON Schema in `input_schema` tells the
    model what to send and most models comply, but nothing enforces it — a missing
    required field arrives as an absent key, not an error.
    """
    message = (args.get("message") or "").strip()
    if not message:
        return ToolResult.error("`message` is required — pass the text to echo.")
    return ToolResult.ok(f"echo: {message}")


async def _whoami(ctx: ToolContext, _args: dict[str, Any]) -> ToolResult:
    """Report the VERIFIED caller.

    `ctx.identity` is the output of the broker's two-token check, so
    `conversation_id` is trustworthy in a way the old `?conv=` query param never was.
    `owner` is populated only on the control-plane path (it rides in the conversation
    token); a sandbox's SA name carries no owner, so it is None there rather than
    guessed.
    """
    identity = ctx.identity
    return ToolResult.ok(
        "\n".join(
            [
                f"conversation: {identity.conversation_id}",
                f"owner: {identity.owner or '(unknown — a sandbox SA carries none)'}",
                f"service account: {identity.service_account}",
                f"namespace: {identity.namespace}",
            ]
        )
    )


async def _upstream(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    """Call the provider's upstream with its credential injected.

    `ctx.upstream` is the same build-request-then-inject path the http-proxy transport
    uses, so a provider's tool and its raw route cannot drift in how they
    authenticate. The agent never holds the secret.

    `from_upstream` is the load-bearing part: a non-2xx comes back with the real status
    and the upstream body UNMODIFIED. The agent's recovery depends on the actual
    message, and a hidden error gets retried — which for a `respond`-shaped tool means
    posting twice.
    """
    path = (args.get("path") or "").strip().lstrip("/")
    if not path:
        return ToolResult.error("`path` is required — the upstream path to GET.")
    response = await ctx.upstream.request("GET", path)
    return ToolResult.from_upstream(
        response,
        success_text=f"GET {path} returned {response.status_code}.",
        # Set for an API that reports logical failure with a 200 body (Slack's
        # `{"ok": false}`). Without it, a failed post reads as a success.
        ok_field_check=True,
        # Logical errors that mean "the desired state already exists" — which is
        # SUCCESS, not failure. Slack's `already_reacted` is the real case: the
        # webhooks handler posts a 👀 before dispatch, so the agent's own ack-react
        # always failed until these were treated as done.
        idempotent_errors=("already_done",),
    )


async def _attached(ctx: ToolContext, _args: dict[str, Any]) -> ToolResult:
    links = [l for l in await ctx.links.list() if l.get("source") == LINK_SOURCE]
    urls = ", ".join(str(l.get("url")) for l in links) or "(none)"
    return ToolResult.ok(f"this conversation's {LINK_SOURCE} links: {urls}")


async def _has_echo_link(ctx: ToolContext) -> bool:
    """The attachment gate: is an `echo` resource attached to THIS conversation?

    Returning False leaves the tool unregistered for this conversation — the agent
    does not see it at all, rather than seeing it and failing when it fires. A gate
    that RAISES is also treated as "not attached" by the broker, never as attached,
    so a link lookup failing cannot accidentally expose a reply tool.
    """
    return any(l.get("source") == LINK_SOURCE for l in await ctx.links.list())


def echo_mcp_tools() -> list[McpTool]:
    """Echo's tools. Called by the provider factory, which hands them to `McpTools`."""
    return [
        McpTool(
            name="echo_say",
            title="Echo a message",
            # The description is the model's ONLY instruction manual for a tool: it
            # decides from this whether to call it and with what. Say what the tool
            # does, when to prefer it, and anything surprising — these are written at
            # the length of the real ones in agentTools.ts for that reason.
            description=(
                "Echo a message back. The reference tool for Scooter's contrib MCP "
                "surface — it proves the path from the agent through the broker to a "
                "contrib and back, and is useful for nothing else."
            ),
            input_schema={
                "type": "object",
                "properties": {"message": {"type": "string", "description": "The text to echo."}},
                "required": ["message"],
            },
            handler=_say,
        ),
        McpTool(
            name="echo_whoami",
            title="Show the verified caller",
            description=(
                "Report the conversation, owner and service account the broker "
                "VERIFIED for this call. Use it to confirm a tool call is scoped to "
                "the conversation you expect; the values come from a signed token, not "
                "from anything the agent supplied."
            ),
            handler=_whoami,
        ),
        McpTool(
            name="echo_upstream",
            title="Call the echo upstream",
            description=(
                "GET a path on this provider's upstream API with the provider's "
                "credential injected by the broker. Demonstrates a typed tool over the "
                "same call the raw proxy route makes; a failure is returned to you with "
                "the real HTTP status and the upstream body verbatim — do NOT retry "
                "blindly on an error."
            ),
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Upstream path to GET."}},
                "required": ["path"],
            },
            handler=_upstream,
        ),
        McpTool(
            name="echo_attached",
            title="List the attached echo resources",
            description=(
                "List the `echo` resources linked to THIS conversation. Offered only "
                "when at least one is attached — the attachment gate, so you are never "
                "shown a tool for a resource that is not there."
            ),
            handler=_attached,
            gate=_has_echo_link,
        ),
    ]
