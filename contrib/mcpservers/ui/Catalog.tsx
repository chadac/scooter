// Catalog and registry rows for the add-server browser.

import { Button, cn } from "@/src/contrib/sdk";

export type Kind = "npm" | "pypi" | "nixpkgs";

export interface CatalogEntry {
  /** Suggested name; empty for registry rows. */
  name: string;
  kind: Kind;
  spec: string;
  args: string[];
  description: string;
  needsApiKey: boolean;
  /** The registry's reverse-DNS name, registry rows only. */
  registryName?: string;
}

export const KIND_LABEL: Record<Kind, string> = { npm: "npm", pypi: "PyPI", nixpkgs: "nixpkgs" };

const isKind = (k: unknown): k is Kind => k === "npm" || k === "pypi" || k === "nixpkgs";

function entry(row: unknown, named: boolean): CatalogEntry | null {
  const r = row as Record<string, unknown> | null;
  if (!r || typeof r.spec !== "string" || !isKind(r.kind)) return null;
  if (named && typeof r.name !== "string") return null;
  return {
    name: named ? (r.name as string) : "",
    kind: r.kind,
    spec: r.spec,
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [],
    description: typeof r.description === "string" ? r.description : "",
    needsApiKey: r.needs_api_key === true,
    registryName: typeof r.registry_name === "string" ? r.registry_name : undefined,
  };
}

function parse(body: unknown, named: boolean): CatalogEntry[] {
  const rows = (body as { servers?: unknown } | null)?.servers;
  return Array.isArray(rows) ? rows.map((r) => entry(r, named)).filter((e): e is CatalogEntry => e !== null) : [];
}

export const parseCatalog = (body: unknown): CatalogEntry[] => parse(body, true);
export const parseRegistry = (body: unknown): CatalogEntry[] => parse(body, false);

/** A default name: the package's last segment, unversioned. */
export function nameFromSpec(spec: string): string {
  const scope = /^@([^/]+)\//.exec(spec.trim())?.[1] ?? "";
  const bare = spec.trim().replace(/^@[^/]*\//, "").split(/[@=[]/)[0] ?? "";
  let last = (bare.split(/[./]/).pop() ?? "").replace(/^(mcp-server-|server-)/, "");
  // A bare "mcp" says nothing; the scope names it (@playwright/mcp).
  if (scope && /^(mcp|server)$/.test(last)) last = scope;
  return last.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

/** The spec without its version suffix, for "already added" matching. */
export function specBase(spec: string): string {
  return spec.replace(/(.)(?:@|==)[^@=/]+$/, "$1");
}

export const specKey = (kind: string, spec: string): string => `${kind} ${specBase(spec)}`;

export function CatalogRow({
  entry: e,
  added,
  busy,
  onAdd,
  onEdit,
}: {
  entry: CatalogEntry;
  added: boolean;
  busy: boolean;
  /** One-click add; registry rows only prefill the form. */
  onAdd?: (e: CatalogEntry) => void;
  onEdit: (e: CatalogEntry) => void;
}) {
  return (
    <li
      data-testid="mcp-catalog-item"
      data-spec={e.spec}
      className={cn("flex items-start justify-between gap-3 rounded-md border p-3", e.needsApiKey && "opacity-60")}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{e.registryName ?? e.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {KIND_LABEL[e.kind]}
          </span>
          {added && (
            <span data-testid="mcp-catalog-added" className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
              added
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{e.description}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{[e.spec, ...e.args].join(" ")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {e.needsApiKey ? (
          <span data-testid="mcp-catalog-keyed" className="text-[11px] text-muted-foreground">
            needs an API key
          </span>
        ) : added ? null : (
          <>
            {onAdd && (
              <Button variant="default" size="xs" data-testid="mcp-catalog-add" disabled={busy} onClick={() => onAdd(e)}>
                Add
              </Button>
            )}
            <Button variant="outline" size="xs" data-testid="mcp-catalog-edit" disabled={busy} onClick={() => onEdit(e)}>
              {onAdd ? "Edit…" : "Add…"}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function CatalogList({
  entries,
  addedSpecs,
  busy,
  onAdd,
  onEdit,
}: {
  entries: CatalogEntry[];
  addedSpecs: Set<string>;
  busy: boolean;
  onAdd?: (e: CatalogEntry) => void;
  onEdit: (e: CatalogEntry) => void;
}) {
  return (
    <ul data-testid="mcp-catalog-list" className="flex flex-col gap-1.5">
      {entries.map((e) => (
        <CatalogRow
          key={`${e.kind}:${e.spec}:${e.registryName ?? e.name}`}
          entry={e}
          added={addedSpecs.has(specKey(e.kind, e.spec))}
          busy={busy}
          onAdd={onAdd}
          onEdit={onEdit}
        />
      ))}
    </ul>
  );
}
