# Bug: the BYOC MCP tunnel carries frames end-to-end, but the container's Claude never gets a usable `scooter-env` server — every tool call fails `stop_reason=tool_use`

**Repo:** `chadac/scooter`. **Component:** `services/remote-agent` (`src/mcpProxy.ts`, `src/remoteAgentClient.ts`) ⟷ `services/claude-sdk-provider` (`src/sdkClient.ts`). **Severity:** High — a BYO agent silently has *no platform tools*: no background jobs, model switch, scheduler, subagents, or marimo. It can describe them (they are in its skills) but cannot invoke them, so it tells the user the tool does not exist.

**Observed on:** odin, branch `feat/mcp-tunnel` @ `1832308`, container built from the same branch, single container attached (no contention).

## Symptom

Ask a BYO conversation to use a platform tool:

> Use your list_models tool and reply with just the number of models it returns.

The model replies that it has no such tool — while *naming* `scooter-env` in its reasoning — and the container logs:

```
[sdk] prompt: query stream error: Error: Claude Code returned an error result:
      [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use
```

## Everything underneath is proven healthy — this is NOT the transport

Verified live, in one run:

- the cloud OFFERS the server by name and the container starts a local proxy:
  `[remote-agent] MCP: scooter-env proxied over the tunnel`
- the container OPENS tunnel streams and the agent-host SERVES them — 8 in a single run:
  `[tunnel] open stream=3840225d-… target="scooter-env" conversation=…`
- the controller's inbound route serves (`GET /byoc/:id/tunnel` → 200) and the reply route accepts
- the agent-host's MCP endpoint returns **25 tools including `list_models`**:
  ```
  marimo_execute … run_background … spawn_subagent … list_models switch_model … create_scheduled_task
  ```

So: frames flow both directions, the target resolves, and the server has the tool. The failure is between the proxy and the model.

## Ruled out

| candidate | evidence it is not the cause |
|---|---|
| the inbound channel | was a real gap, fixed in `1832308`; streams are now served (8 per run) |
| tool availability | the endpoint lists `list_models` |
| the `?conv=` id | a real conversation id and a bogus one both return the same 25 tools |
| container contention | **18 reconnects** from two containers fighting one owner's session invalidated earlier runs; with a single container it still fails |

## Root-cause hypotheses (untested)

The container's brain is the **claude-code SDK, which spawns the `claude` CLI as a subprocess**. The proxy listens on `127.0.0.1:<ephemeral>` *inside the container*, and the CLI's own MCP client must connect to it. Candidates, in rough order of likelihood:

1. **The CLI needs the server in ITS configuration**, not merely in the SDK's `mcpServers` option — the in-cluster path passes `mcpEndpointUrl` and works, so compare exactly how that reaches the CLI versus the new `mcpServers` array.
2. **StreamableHTTP handshake not modelled.** The proxy forwards bytes, but MCP StreamableHTTP has an `initialize` exchange and a session-id header (`Mcp-Session-Id`) the server may require; dropping or failing to echo it would leave the client with an unusable server.
3. **Header handling.** The proxy strips `host` and `content-length`; if it also needs to preserve/forward `accept: text/event-stream` or the session header, the server may answer 406 (the endpoint returns 406 for a GET without the right `Accept`).
4. **Response framing.** The agent-host streams the response body; if the client expects SSE framing that the chunking disturbs, the client sees a malformed response.

## Next diagnostic step (do this before changing code)

Drive the local proxy with a **real MCP client from inside the container** and read what it answers, instead of inferring from the model's prose:

```bash
docker exec scooter-devtest sh -c 'curl -s -X POST http://127.0.0.1:<proxy-port>/ \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}"'
```

That distinguishes "the proxy never answers" from "it answers but the handshake is wrong" — the two branches lead to very different fixes.

## Related

Same shape as the id-correlation hang (#304) and the `release()` contract drift (#307): each component correct against its own fake, the JOINT unexercised. The tunnel has unit tests on every piece and a wiring spec on the offer, but nothing drives a real MCP client through the whole chain — which is exactly the test this bug argues for.
