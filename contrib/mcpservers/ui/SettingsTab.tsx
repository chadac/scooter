// Settings → MCP servers: npm, PyPI and nixpkgs MCP servers started in each sandbox.
//
// Calls go through contribFetch, relayed to /mcpservers/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, cn, contribFetch, ErrorState, monoInputClass, Spinner, textareaClass } from "@/src/contrib/sdk";

type Kind = "npm" | "pypi" | "nixpkgs";

interface Server {
  id: string;
  name: string;
  kind: Kind;
  spec: string;
  args: string[];
  enabled: boolean;
}

const KINDS: Array<{ kind: Kind; label: string; placeholder: string; hint: string }> = [
  {
    kind: "npm",
    label: "npm",
    placeholder: "@modelcontextprotocol/server-everything",
    hint: "An npm package, optionally @version. Runs with npx -y.",
  },
  {
    kind: "pypi",
    label: "PyPI",
    placeholder: "mcp-server-fetch",
    hint: "A PyPI package, optionally ==version. Runs with uv tool run.",
  },
  {
    kind: "nixpkgs",
    label: "nixpkgs",
    placeholder: "mcp-server-time",
    hint: "A nixpkgs attribute. Runs its main program with nix run.",
  },
];

/** A default name: the package's last segment, unversioned. */
function nameFromSpec(spec: string): string {
  const bare = spec.trim().replace(/^@[^/]*\//, "").split(/[@=[]/)[0] ?? "";
  const last = bare.split(/[./]/).pop() ?? "";
  return last.replace(/^(mcp-server-|server-)/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

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

function ServerForm({ onAdded, onCancel }: { onAdded: () => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>("npm");
  const [spec, setSpec] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [args, setArgs] = useState("");
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
              {k.label}
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
  const label = KINDS.find((k) => k.kind === server.kind)?.label ?? server.kind;
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
      {adding && (
        <ServerForm
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
      {servers.length === 0 ? (
        <p data-testid="mcp-servers-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No servers yet. Add one, such as the PyPI package <code className="font-mono text-xs">mcp-server-fetch</code>.
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
