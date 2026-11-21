// Settings → MCP servers: npm, PyPI and nixpkgs MCP servers started in each sandbox.
//
// Calls go through contribFetch, relayed to /mcpservers/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, cn, contribFetch, ErrorState, inputClass, monoInputClass, Spinner, textareaClass } from "@/src/contrib/sdk";

import {
  type CatalogEntry,
  CatalogList,
  type Kind,
  KIND_LABEL,
  nameFromSpec,
  parseCatalog,
  parseRegistry,
  specKey,
} from "./Catalog.js";

interface Server {
  id: string;
  name: string;
  kind: Kind;
  spec: string;
  args: string[];
  enabled: boolean;
}

const KINDS: Array<{ kind: Kind; placeholder: string; hint: string }> = [
  {
    kind: "npm",
    placeholder: "@modelcontextprotocol/server-everything",
    hint: "An npm package, optionally @version. Runs with npx -y.",
  },
  {
    kind: "pypi",
    placeholder: "mcp-server-fetch",
    hint: "A PyPI package, optionally ==version. Runs with uv tool run.",
  },
  {
    kind: "nixpkgs",
    placeholder: "mcp-server-time",
    hint: "A nixpkgs attribute. Runs its main program with nix run.",
  },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await contribFetch("mcpservers", path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function ServerForm({
  initial,
  onAdded,
  onCancel,
}: {
  initial?: Partial<CatalogEntry>;
  onAdded: () => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "npm");
  const [spec, setSpec] = useState(initial?.spec ?? "");
  const [name, setName] = useState<string | null>(initial?.name || null);
  const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.kind === kind)!;
  const shownName = name ?? nameFromSpec(spec);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const argv = args.split("\n").map((a) => a.trim()).filter(Boolean);
      await api("servers", {
        method: "POST",
        body: JSON.stringify({ name: shownName.trim(), kind, spec: spec.trim(), args: argv }),
      });
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="mcp-server-form" className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">From</span>
        <div className="flex gap-1" role="radiogroup">
          {KINDS.map((k) => (
            <Button
              key={k.kind}
              variant={k.kind === kind ? "default" : "outline"}
              size="xs"
              role="radio"
              aria-checked={k.kind === kind}
              data-testid={`mcp-server-kind-${k.kind}`}
              onClick={() => setKind(k.kind)}
            >
              {KIND_LABEL[k.kind]}
            </Button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Package</span>
        <input
          data-testid="mcp-server-spec"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder={meta.placeholder}
          className={monoInputClass}
        />
        <span className="text-[11px] text-muted-foreground">{meta.hint}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <input
          data-testid="mcp-server-name"
          value={shownName}
          onChange={(e) => setName(e.target.value)}
          placeholder="fetch"
          className={monoInputClass}
        />
        <span className="text-[11px] text-muted-foreground">
          Scooter sees its tools as <code className="font-mono">mcp__sandbox-{shownName || "<name>"}__…</code>.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Arguments (optional)</span>
        <textarea
          data-testid="mcp-server-args"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder={"--headless"}
          rows={2}
          className={cn(textareaClass, "font-mono")}
        />
        <span className="text-[11px] text-muted-foreground">
          One per line. Don’t put API keys here: Scooter can read everything in its sandbox.
        </span>
      </label>
      {error && (
        <p data-testid="mcp-server-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          data-testid="mcp-server-submit"
          disabled={!spec.trim() || !shownName.trim() || busy}
          onClick={submit}
        >
          {busy ? "Adding…" : "Add server"}
        </Button>
        <Button variant="outline" size="sm" data-testid="mcp-server-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Add-server browser: catalog, registry search and custom form. */
function AddPanel({
  servers,
  refresh,
  onClose,
}: {
  servers: Server[];
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [registryRows, setRegistryRows] = useState<CatalogEntry[]>([]);
  const [registryError, setRegistryError] = useState(false);
  const [searching, setSearching] = useState(false);
  const [form, setForm] = useState<Partial<CatalogEntry> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("catalog")
      .then((body) => setCatalog(parseCatalog(body)))
      .catch(() => setCatalog([]));
  }, []);

  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (q.length < 2) {
      setRegistryRows([]);
      setRegistryError(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setRegistryRows(parseRegistry(await api(`registry?q=${encodeURIComponent(q)}`)));
        setRegistryError(false);
      } catch {
        setRegistryRows([]);
        setRegistryError(true);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  if (form) {
    return (
      <ServerForm
        initial={form}
        onCancel={() => setForm(null)}
        onAdded={async () => {
          await refresh();
          onClose();
        }}
      />
    );
  }

  const addedSpecs = new Set(servers.map((s) => specKey(s.kind, s.spec)));
  const catalogShown = (catalog ?? []).filter(
    (e) => !q || e.name.includes(q) || e.spec.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
  );
  const catalogKeys = new Set((catalog ?? []).map((e) => specKey(e.kind, e.spec)));
  const registryShown = registryRows.filter((e) => !catalogKeys.has(specKey(e.kind, e.spec)));

  const addNow = async (e: CatalogEntry) => {
    setBusy(true);
    setError(null);
    try {
      await api("servers", {
        method: "POST",
        body: JSON.stringify({ name: e.name || nameFromSpec(e.spec), kind: e.kind, spec: e.spec, args: e.args }),
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="mcp-catalog-panel" className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="mcp-catalog-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the catalog and the MCP registry"
          className={cn(inputClass, "min-w-48 flex-1")}
        />
        <Button variant="outline" size="sm" data-testid="mcp-server-custom" onClick={() => setForm({})}>
          Custom package
        </Button>
        <Button variant="outline" size="sm" data-testid="mcp-catalog-close" onClick={onClose}>
          Close
        </Button>
      </div>
      {error && (
        <p data-testid="mcp-catalog-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {catalog === null ? (
        <Spinner />
      ) : catalogShown.length > 0 ? (
        <CatalogList entries={catalogShown} addedSpecs={addedSpecs} busy={busy} onAdd={addNow} onEdit={setForm} />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing in the catalog matches.</p>
      )}
      {q.length >= 2 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">From the MCP registry</span>
          {searching ? (
            <Spinner />
          ) : registryError ? (
            <p data-testid="mcp-registry-error" className="text-sm text-muted-foreground">
              The MCP registry is unreachable right now.
            </p>
          ) : registryShown.length === 0 ? (
            <p data-testid="mcp-registry-empty" className="text-sm text-muted-foreground">
              No runnable registry match.
            </p>
          ) : (
            <CatalogList entries={registryShown} addedSpecs={addedSpecs} busy={busy} onEdit={setForm} />
          )}
        </div>
      )}
    </div>
  );
}

function ServerRow({ server, onChanged }: { server: Server; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const label = KIND_LABEL[server.kind] ?? server.kind;
  return (
    <li
      data-testid="mcp-server-item"
      data-enabled={server.enabled}
      className="flex items-start justify-between gap-3 rounded-md border p-3"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="mcp-server-name-text" className="font-mono text-sm font-medium">
            {server.name}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{label}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              server.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
            )}
          >
            {server.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {[server.spec, ...server.args].join(" ")}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="outline"
          size="xs"
          data-testid="mcp-server-toggle"
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`servers/${server.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !server.enabled }) }),
            )
          }
        >
          {server.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-testid="mcp-server-delete"
          disabled={busy}
          aria-label={`Remove ${server.name}`}
          onClick={() => {
            if (confirm(`Remove the MCP server “${server.name}”?`)) {
              void run(() => api(`servers/${server.id}`, { method: "DELETE" }));
            }
          }}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export default function McpServersSettingsTab() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setServers((await api<{ servers: Server[] }>("servers")).servers);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) return <ErrorState title="Couldn't load your MCP servers" error={error} />;
  if (!servers) return <Spinner />;

  return (
    <section data-testid="mcp-servers-tab" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">MCP servers</h2>
          <p className="text-sm text-muted-foreground">
            MCP servers started in each conversation’s sandbox. Scooter gets their tools once a server is running,
            and a change here reaches running sandboxes within a couple of minutes.
          </p>
        </div>
        {!adding && (
          <Button variant="default" size="sm" data-testid="mcp-server-new" onClick={() => setAdding(true)}>
            + Add server
          </Button>
        )}
      </div>
      {adding && <AddPanel servers={servers} refresh={refresh} onClose={() => setAdding(false)} />}
      {servers.length === 0 ? (
        <p data-testid="mcp-servers-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No servers yet. Add one from the catalog, such as <code className="font-mono text-xs">fetch</code>.
        </p>
      ) : (
        <ul data-testid="mcp-server-list" className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} onChanged={refresh} />
          ))}
        </ul>
      )}
    </section>
  );
}
