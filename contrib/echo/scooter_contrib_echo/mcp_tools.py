"""Echo's AGENT TOOLS — the worked example of the contrib tool surface.

A contrib owns its credential source, its routes, its webhooks handler, its UI row and
its skills; since issue #700 it owns its agent TOOLS too. This file is the reference
for that, the way `broker_provider.py` is the reference for a custom Transport.

Tools are declared on the contrib's own `FastMCP` server with `@mcp.tool`: the input
schema comes from the type hints and the description from the docstring, so there is
no JSON Schema to hand-write and keep in sync. The broker mounts this server
NAMESPACE-LESS, so `echo_say` stays `echo_say` — the skills name these tools and
`ui/src/toolCallView.ts` matches on the name.

`ctx: ToolContext = ToolContextDep` is dependency-injected, which also keeps it out of
the tool's input schema — a `ctx` argument the model could try to supply would be both
confusing and forgeable. The context carries the VERIFIED caller, a credential-injecting
upstream caller, and the conversation's links; a contrib never assembles its own.

Each tool below demonstrates one thing a real integration needs, rather than four
variations of hello-world:

  echo_say        the minimum: typed arguments in, a string out.
  echo_whoami     reading the VERIFIED caller. `identity.conversation_id` is the whole
                  point of #700 — it comes from a signed token or an SA name, never
                  from anything the agent sent.
  echo_upstream   calling an API through `ctx.upstream`, which injects the provider's
                  credential on the way out, plus every branch of the never-hide-an-
                  error rule.
  echo_attached   the ATTACHMENT GATE. Listed only when this conversation has an
                  `echo` link, so the agent is never shown a reply tool for a resource
                  that is not there. An ungated reply tool is what once sent the agent
                  raw-curling Slack into the root channel.

Loaded only in the broker image (it imports the broker surface), via the provider
factory in broker_provider.py. `contrib/echo` ships with `enable = false`, so these
tools reach a real broker only in the test/example images that turn it on.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

# The link source that gates `echo_attached`. A real contrib uses its own source name
# — "github", "slack" — which is what `agent-broker link add --source` records.
LINK_SOURCE = "echo"

mcp = FastMCP(name="echo")


async def _has_echo_link(ctx: ToolContext) -> bool:
    """The attachment gate: is an `echo` resource attached to THIS conversation?

    False leaves the tool unlisted for this conversation — the agent does not see it at
    all, rather than seeing it and failing when it fires. A gate that RAISES is also
    treated as "not attached" by the broker, never as attached, so a link lookup
    failing cannot accidentally expose a reply tool.
    """
    return any(link.get("source") == LINK_SOURCE for link in await ctx.links.list())


@mcp.tool
async def echo_say(message: str, ctx: ToolContext = ToolContextDep) -> str:
    """Echo a message back.

    The reference tool for Scooter's contrib MCP surface — it proves the path from the
    agent through the broker to a contrib and back, and is useful for nothing else.
    """
    # Validation is still the TOOL'S job for anything the type system cannot say.
    # fastmcp rejects a missing or wrongly-typed `message` from the schema, but "not
    # only whitespace" is not a type.
    text = message.strip()
    if not text:
        return "`message` is required — pass the text to echo."
    return f"echo: {text}"


@mcp.tool
async def echo_whoami(ctx: ToolContext = ToolContextDep) -> str:
    """Report the conversation, owner and service account the broker VERIFIED for this
    call.

    Use it to confirm a tool call is scoped to the conversation you expect; the values
    come from a signed token, not from anything the agent supplied.
    """
    identity = ctx.identity
    return "\n".join(
        [
            f"conversation: {identity.conversation_id}",
            # `owner` rides in the conversation token, so it is present on the
            # control-plane path and absent for a sandbox's own SA. Reported as
            # unknown rather than guessed.
            f"owner: {identity.owner or '(unknown — a sandbox SA carries none)'}",
            f"service account: {identity.service_account}",
            f"namespace: {identity.namespace}",
        ]
    )


@mcp.tool
async def echo_upstream(path: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """GET a path on this provider's upstream API, with the provider's credential
    injected by the broker.

    Demonstrates a typed tool over the same call the raw proxy route makes. A failure
    is returned to you with the real HTTP status and the upstream body verbatim — do
    NOT retry blindly on an error.
    """
    target = path.strip().lstrip("/")
    if not target:
        return ToolResult.error("`path` is required — the upstream path to GET.")
    # ctx.upstream is the same build-request-then-inject path HttpProxy uses, so a
    # provider's tool and its raw route cannot drift in how they authenticate. The
    # agent never holds the secret.
    response = await ctx.upstream.request("GET", target)
    return ToolResult.from_upstream(
        response,
        success_text=f"GET {target} returned {response.status_code}.",
        # For an API that reports logical failure with a 200 body (Slack's
        # `{"ok": false}`). Without it, a failed post reads as a success.
        ok_field_check=True,
        # Logical errors meaning "the desired state already exists", which is SUCCESS.
        # Slack's `already_reacted` is the real case: the webhooks handler posts a 👀
        # before dispatch, so the agent's own ack-react always failed until these
        # counted as done.
        idempotent_errors=("already_done",),
    )


@gate(_has_echo_link)
@mcp.tool
async def echo_attached(ctx: ToolContext = ToolContextDep) -> str:
    """List the `echo` resources linked to THIS conversation.

    Offered only when at least one is attached — the attachment gate, so you are never
    shown a tool for a resource that is not there.
    """
    links = [link for link in await ctx.links.list() if link.get("source") == LINK_SOURCE]
    urls = ", ".join(str(link.get("url")) for link in links) or "(none)"
    return f"this conversation's {LINK_SOURCE} links: {urls}"


def echo_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
