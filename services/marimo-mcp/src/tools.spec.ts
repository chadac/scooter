/** Unit — the marimo tool handlers over a FAKE client (no HTTP). Covers the
 *  happy paths, the code-mode marker plumbing, and error→ToolResult mapping. */

import { describe, it, expect, vi } from "vitest";

import { createMarimoTools, MARIMO_EMBED_FENCE } from "./tools.js";
import type { MarimoClient } from "./client.js";
import type { ExecuteResult } from "./types.js";
import { MarimoError } from "./types.js";
import { CODE_MODE_MARKER } from "./codeMode.js";
import { ISLAND_MARKER } from "./island.js";
import type { IslandExec, IslandUvConfig } from "./islandRunner.js";

const result = (over: Partial<ExecuteResult> = {}): ExecuteResult => ({
  success: true,
  stdout: "",
  stderr: "",
  output: "",
  ...over,
});

/** A fake client whose execute() is scripted. `execute` records the code it saw. */
function fakeClient(over: Partial<MarimoClient> = {}): MarimoClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listSessions: over.listSessions ?? (async () => ({})),
    resolveSession: over.resolveSession ?? (async () => "s1"),
    execute:
      over.execute ??
      (async (code: string) => {
        calls.push(code);
        return result();
      }),
  } as MarimoClient & { calls: string[] };
}

/** A done result whose stdout carries the code-mode marker (ok). */
const markerOk = (obj: Record<string, unknown>) =>
  result({ stdout: `${CODE_MODE_MARKER} ${JSON.stringify({ ok: true, ...obj })}\n` });

describe("marimo tools", () => {
  describe("execute (scratchpad)", () => {
    it("returns stdout + the => output on success", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => result({ stdout: "hi\n", output: "7" }) }));
      const r = await tools.execute({ code: "print('hi'); 3+4" });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("hi");
      expect(r.content[0].text).toContain("=> 7");
    });

    it("marks isError + shows the traceback on a Python failure", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => result({ success: false, stderr: "NameError: x" }) }));
      const r = await tools.execute({ code: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("NameError");
    });

    it("maps a no-session error to an actionable 'ask the user to open it' message", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => { throw new MarimoError("none", "no-session"); } }));
      const r = await tools.execute({ code: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text.toLowerCase()).toContain("open");
      expect(r.content[0].text.toLowerCase()).toContain("browser");
    });

    it("the no-session message includes the notebook URL when provided", async () => {
      const tools = createMarimoTools(
        fakeClient({ execute: async () => { throw new MarimoError("none", "no-session"); } }),
        { notebookUrl: "https://scooter.example.com/c/t1/marimo/" },
      );
      const r = await tools.execute({ code: "x" });
      expect(r.content[0].text).toContain("https://scooter.example.com/c/t1/marimo/");
    });

    it("maps unreachable to a sandbox-asleep hint", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => { throw new MarimoError("ECONNREFUSED", "unreachable"); } }));
      const r = await tools.execute({ code: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text.toLowerCase()).toContain("asleep");
    });
  });

  describe("listSessions", () => {
    it("lists open notebooks with paths", async () => {
      const tools = createMarimoTools(fakeClient({ listSessions: async () => ({ s1: { path: "/w/a.py" }, s2: {} }) }));
      const r = await tools.listSessions();
      expect(r.content[0].text).toContain("s1");
      expect(r.content[0].text).toContain("/w/a.py");
    });

    it("says none open when empty", async () => {
      const tools = createMarimoTools(fakeClient({ listSessions: async () => ({}) }));
      expect((await tools.listSessions()).content[0].text.toLowerCase()).toContain("no marimo");
    });
  });

  describe("createCell / runCell / listCells (code-mode)", () => {
    it("createCell runs a create_cell snippet and reports the new cell id", async () => {
      const client = fakeClient({ execute: async (code: string) => { client.calls.push(code); return markerOk({ cell_id: "cell-1" }); } });
      const tools = createMarimoTools(client);
      const r = await tools.createCell({ code: "1+1" });
      expect(r.isError).toBeFalsy();
      expect(client.calls[0]).toContain("create_cell");
      expect(r.content[0].text).toContain("cell-1");
    });

    it("createCell with run:true creates THEN runs the cell", async () => {
      const seen: string[] = [];
      const client = fakeClient({
        execute: async (code: string) => {
          seen.push(code.includes("create_cell") ? "create" : code.includes("run_cell") ? "run" : "other");
          return markerOk({ cell_id: "cell-9" });
        },
      });
      const tools = createMarimoTools(client);
      const r = await tools.createCell({ code: "df.head()", run: true });
      expect(seen).toEqual(["create", "run"]);
      expect(r.content[0].text).toContain("cell-9");
    });

    it("createCell surfaces a failure when the code-mode op didn't complete (no marker)", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => result({ success: false, stderr: "AttributeError: get_context" }) }));
      const r = await tools.createCell({ code: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("AttributeError");
    });

    it("runCell targets the given cell id", async () => {
      const client = fakeClient({ execute: async (code: string) => { client.calls.push(code); return markerOk({ cell_id: "c7" }); } });
      const tools = createMarimoTools(client);
      const r = await tools.runCell({ cell_id: "c7" });
      expect(client.calls[0]).toContain('run_cell("c7")');
      expect(r.isError).toBeFalsy();
    });

    it("listCells returns the marker payload", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => markerOk({ cells: [{ cell_id: "a" }] }) }));
      const r = await tools.listCells({});
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("list_cells ok");
    });
  });

  describe("install", () => {
    it("installs the packages via a code-mode snippet", async () => {
      const client = fakeClient({ execute: async (code: string) => { client.calls.push(code); return markerOk({ installed: ["matplotlib"] }); } });
      const tools = createMarimoTools(client);
      const r = await tools.install({ packages: ["matplotlib"] });
      expect(r.isError).toBeFalsy();
      expect(client.calls[0]).toContain("ctx.packages.add");
      expect(client.calls[0]).toContain("matplotlib");
      expect(r.content[0].text).toContain("install ok");
    });

    it("rejects an empty package list without hitting the client", async () => {
      const execute = vi.fn(async () => result());
      const tools = createMarimoTools(fakeClient({ execute }));
      const r = await tools.install({ packages: ["  ", ""] });
      expect(r.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });

    it("surfaces an install failure (no marker) with the traceback", async () => {
      const tools = createMarimoTools(fakeClient({ execute: async () => result({ success: false, stderr: "ResolutionImpossible: nope" }) }));
      const r = await tools.install({ packages: ["does-not-exist-xyz"] });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("ResolutionImpossible");
    });
  });

  it("passes file/session selectors through to the client", async () => {
    const execute = vi.fn(async () => result());
    const tools = createMarimoTools(fakeClient({ execute }));
    await tools.execute({ code: "x", file: "/w/a.py" });
    expect(execute).toHaveBeenCalledWith("x", { file: "/w/a.py", sessionId: undefined });
  });
});

// --- marimo_embed (WASM island) ------------------------------------------------
const islandUv: IslandUvConfig = { uvBin: "/uv", env: { UV_PYTHON: "/py", UV_PYTHON_DOWNLOADS: "never" } };
const islandStdout = (island = "<marimo-island>c</marimo-island>", head = "<script></script>") =>
  `${ISLAND_MARKER} ${JSON.stringify({ islandHtml: island, headHtml: head })}`;

function islandExec(over: { stdout?: string; stderr?: string; exitCode?: number } = {}): IslandExec {
  return {
    execute: vi.fn(async () => ({ stdout: islandStdout(), stderr: "", exitCode: 0, ...over })),
  };
}

describe("marimo_embed", () => {
  it("errors when no island capability is wired", async () => {
    const tools = createMarimoTools(fakeClient());
    const r = await tools.embed({ code: "mo.md('x')" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.toLowerCase()).toContain("unavailable");
  });

  it("rejects an empty code", async () => {
    const tools = createMarimoTools(fakeClient(), { island: { exec: islandExec(), uv: islandUv } });
    const r = await tools.embed({ code: "   " });
    expect(r.isError).toBe(true);
  });

  it("returns the island wrapped in the marimo-embed fence (base64 payload)", async () => {
    const tools = createMarimoTools(fakeClient(), { island: { exec: islandExec(), uv: islandUv } });
    const r = await tools.embed({ code: "import marimo as mo\nmo.md('hi')", title: "My chart" });
    expect(r.isError).toBeFalsy();
    const text = r.content[0].text;
    expect(text).toContain("Embedded a live marimo cell — My chart");
    expect(text).toContain("```" + MARIMO_EMBED_FENCE);
    // Decode the fenced base64 payload → the island html + head + title round-trip.
    const m = text.match(new RegExp("```" + MARIMO_EMBED_FENCE + "\\n([A-Za-z0-9+/=]+)\\n```"));
    expect(m).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(m![1], "base64").toString("utf8"));
    expect(decoded.islandHtml).toContain("<marimo-island>");
    expect(decoded.headHtml).toContain("<script>");
    expect(decoded.title).toBe("My chart");
  });

  it("surfaces a generation failure as an error", async () => {
    const tools = createMarimoTools(fakeClient(), { island: { exec: islandExec({ exitCode: 1, stderr: "boom", stdout: "" }), uv: islandUv } });
    const r = await tools.embed({ code: "x" });
    expect(r.isError).toBe(true);
  });
});
