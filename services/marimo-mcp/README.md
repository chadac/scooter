# @scooter/marimo-mcp

MCP tools for driving a running [marimo](https://marimo.io) notebook from the
agent. The agent-host mounts these into its MCP endpoint so both providers (goose
over HTTP, the claude-code SDK) can call them.

## Tools

- **`marimo_execute`** — run Python in the notebook's scratchpad; returns stdout +
  the last expression's value. The stable workhorse (marimo's `/api/kernel/execute`
  SSE endpoint). Prefer this over a shell for data/compute work — a notebook is
  persistent, visible, and re-runnable.
- **`marimo_list_sessions`** — list the open notebooks on the server.
- **`marimo_create_cell` / `marimo_run_cell` / `marimo_list_cells`** — structural
  cell ops via marimo's `marimo._code_mode` API (needs marimo ≥ 0.21.1). These run
  a small code-mode snippet *through* the scratchpad, since there's no HTTP endpoint
  for them.

## Design

The fragile marimo-protocol knowledge is isolated here:

- `sse.ts` — the execute SSE frame parser + fold.
- `client.ts` — the `node:http` client for one `marimo edit --no-token` server
  (`GET /api/sessions`, `POST /api/kernel/execute` with `Marimo-Session-Id`).
- `codeMode.ts` — the version-pinned `marimo._code_mode` snippet builders (the
  moving-target surface; marimo issue #4345 is open).
- `tools.ts` — pure `ToolResult` handlers over a client (HTTP/MCP-free).
- `index.ts` — the MCP registration (Zod schemas).

The tools target ONE marimo server — the conversation's in-pod marimo at
`podIP:2718`. The agent-host resolves that target fresh per call (the pod IP changes
across suspend/resume) and builds a client.

## Test

```bash
npx vitest run --project marimo-mcp
```

Covers the SSE parser, the client against a fake marimo `http.Server`, the code-mode
snippets, the tool handlers, and the MCP registration end-to-end.
