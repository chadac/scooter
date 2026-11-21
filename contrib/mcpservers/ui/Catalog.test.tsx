/** Catalog parsing, version-blind matching and row rendering. */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CatalogList, nameFromSpec, parseCatalog, parseRegistry, specBase } from "./Catalog.js";

const row = (over: Record<string, unknown> = {}) => ({
  name: "fetch", kind: "pypi", spec: "mcp-server-fetch", description: "Fetch a URL", ...over,
});

describe("parseCatalog / parseRegistry", () => {
  it("maps rows and drops malformed ones", () => {
    const list = parseCatalog({ servers: [row({ args: ["--x", 7] }), { kind: "npm" }, row({ kind: "deb" }), null] });
    expect(list).toEqual([
      { name: "fetch", kind: "pypi", spec: "mcp-server-fetch", args: ["--x"], description: "Fetch a URL", needsApiKey: false, registryName: undefined },
    ]);
    expect(parseCatalog(null)).toEqual([]);
  });

  it("keeps the keyed flag and the registry name", () => {
    const [e] = parseRegistry({ servers: [row({ registry_name: "io.github.x/y", needs_api_key: true })] });
    expect(e.registryName).toBe("io.github.x/y");
    expect(e.needsApiKey).toBe(true);
    expect(e.name).toBe("");
  });
});

describe("specBase", () => {
  it("strips a version from every kind of spec", () => {
    expect(specBase("mcp-server-fetch==2025.4.7")).toBe("mcp-server-fetch");
    expect(specBase("@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(specBase("@scope/pkg")).toBe("@scope/pkg");
    expect(specBase("pkg[extra]==1.0")).toBe("pkg[extra]");
    expect(specBase("mcp-server-time")).toBe("mcp-server-time");
  });
});

describe("nameFromSpec", () => {
  it("derives a bare name", () => {
    expect(nameFromSpec("@playwright/mcp")).toBe("playwright");
    expect(nameFromSpec("@modelcontextprotocol/server-git")).toBe("git");
    expect(nameFromSpec("mcp-server-fetch==1.0")).toBe("fetch");
  });
});

describe("CatalogList", () => {
  const render = (entries: unknown[], added: string[] = [], instant = true) =>
    renderToStaticMarkup(
      <CatalogList
        entries={parseCatalog({ servers: entries })}
        addedSpecs={new Set(added)}
        busy={false}
        onAdd={instant ? () => {} : undefined}
        onEdit={() => {}}
      />,
    );

  it("marks added entries and greys keyed ones", () => {
    const html = render(
      [row(), row({ name: "git", spec: "mcp-server-git" }), row({ name: "github", spec: "github-mcp-server", kind: "nixpkgs", needs_api_key: true })],
      ["pypi mcp-server-fetch"],
    );
    expect(html).toContain('data-testid="mcp-catalog-added"');
    expect(html).toContain('data-testid="mcp-catalog-keyed"');
    // The added and keyed rows lose their buttons; git keeps both.
    expect(html.match(/data-testid="mcp-catalog-add"/g)).toHaveLength(1);
  });

  it("offers only a prefill button for registry rows", () => {
    const html = render([row()], [], false);
    expect(html).not.toContain('data-testid="mcp-catalog-add"');
    expect(html).toContain("Add…");
  });
});
