/** The MCP servers section: the broker's listing mapped to rows, and the list it renders. */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { parseListing, ServerList } from "./Panel.js";

const row = (over: Record<string, unknown> = {}) => ({
  name: "time", kind: "nixpkgs", spec: "mcp-server-time", enabled: true, state: "active",
  tool_prefix: "mcp__sandbox-time__", ...over,
});

describe("parseListing", () => {
  it("maps the snake_case listing", () => {
    const l = parseListing({ servers: [row()], reported_at: "2026-11-06T15:00:00Z", error: null });
    expect(l).toEqual({
      servers: [{ name: "time", kind: "nixpkgs", spec: "mcp-server-time", enabled: true, state: "active", toolPrefix: "mcp__sandbox-time__" }],
      reportedAt: "2026-11-06T15:00:00Z",
      error: null,
    });
  });

  it("drops nameless rows and tolerates a body of the wrong shape", () => {
    expect(parseListing({ servers: [row(), { kind: "npm" }, null] }).servers).toHaveLength(1);
    expect(parseListing(null).servers).toEqual([]);
    expect(parseListing({ servers: "nope" }).servers).toEqual([]);
  });
});

describe("ServerList", () => {
  const render = (body: unknown) => renderToStaticMarkup(<ServerList listing={parseListing(body)} />);

  it("points at Settings when there are no servers", () => {
    expect(render({ servers: [] })).toContain('data-testid="mcpservers-empty"');
  });

  it("labels running, failed, unstarted and disabled servers", () => {
    const html = render({
      servers: [
        row(),
        row({ name: "git", state: "failed" }),
        row({ name: "fetch", state: null }),
        row({ name: "old", enabled: false, state: null }),
      ],
      reported_at: "2026-11-06T15:00:00Z",
    });
    expect(html).toContain('data-server="time" data-state="active"');
    expect(html).toContain('data-server="git" data-state="failed"');
    expect(html).toContain('data-server="fetch" data-state="not started"');
    expect(html).toContain('data-server="old" data-state="disabled"');
    expect(html).toContain("mcp__sandbox-time__");
  });

  it("says the sandbox has not reported before its first sync", () => {
    const html = render({ servers: [row({ state: null })], reported_at: null });
    expect(html).toContain('data-state="waiting for the sandbox"');
    expect(html).toContain("not reported yet");
  });
});
