// Settings → Skill sources: skills.sh packages and GitHub repos installed in each sandbox.
//
// Calls go through contribFetch, relayed to /skills/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, cn, contribFetch, ErrorState, monoInputClass, Spinner } from "@/src/contrib/sdk";

type Kind = "skills.sh" | "github";

interface Source {
  id: string;
  kind: Kind;
  spec: string;
  skills: string[];
  enabled: boolean;
}

const KINDS: Array<{ kind: Kind; label: string; placeholder: string; hint: string }> = [
  {
    kind: "skills.sh",
    label: "skills.sh",
    placeholder: "vercel-labs/agent-skills",
    hint: "Anything npx skills add takes: a package from skills.sh, owner/repo, or a URL.",
  },
  {
    kind: "github",
    label: "GitHub repo",
    placeholder: "anthropics/skills/skills@main",
    hint: "owner/repo, optionally /path and @ref. Every SKILL.md under it is a skill; private repos work.",
  },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await contribFetch("skills", path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function SourceForm({ onAdded, onCancel }: { onAdded: () => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>("skills.sh");
  const [spec, setSpec] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.kind === kind)!;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("sources", { method: "POST", body: JSON.stringify({ kind, spec: spec.trim(), skills: filter }) });
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="skill-source-form" className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
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
              data-testid={`skill-source-kind-${k.kind}`}
              onClick={() => setKind(k.kind)}
            >
              {k.label}
            </Button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Source</span>
        <input
          data-testid="skill-source-spec"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder={meta.placeholder}
          className={monoInputClass}
        />
        <span className="text-[11px] text-muted-foreground">{meta.hint}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Only these skills (optional)</span>
        <input
          data-testid="skill-source-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="frontend-design, web-design-guidelines"
          className={monoInputClass}
        />
        <span className="text-[11px] text-muted-foreground">
          Comma-separated names. Leave empty for every skill in the source.
        </span>
      </label>
      {error && (
        <p data-testid="skill-source-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="default" size="sm" data-testid="skill-source-submit" disabled={!spec.trim() || busy} onClick={submit}>
          {busy ? "Adding…" : "Add source"}
        </Button>
        <Button variant="outline" size="sm" data-testid="skill-source-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SourceRow({ source, onChanged }: { source: Source; onChanged: () => Promise<void> }) {
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
  const label = KINDS.find((k) => k.kind === source.kind)?.label ?? source.kind;
  return (
    <li
      data-testid="skill-source-item"
      data-enabled={source.enabled}
      className="flex items-start justify-between gap-3 rounded-md border p-3"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{label}</span>
          <span data-testid="skill-source-spec-text" className="truncate font-mono text-sm font-medium">
            {source.spec}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              source.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
            )}
          >
            {source.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {source.skills.length ? `Only ${source.skills.join(", ")}` : "Every skill in this source"}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="outline"
          size="xs"
          data-testid="skill-source-toggle"
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !source.enabled }) }),
            )
          }
        >
          {source.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-testid="skill-source-delete"
          disabled={busy}
          aria-label={`Remove ${source.spec}`}
          onClick={() => {
            if (confirm(`Remove the source “${source.spec}”?`)) {
              void run(() => api(`sources/${source.id}`, { method: "DELETE" }));
            }
          }}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export default function SkillSourcesSettingsTab() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSources((await api<{ sources: Source[] }>("sources")).sources);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) return <ErrorState title="Couldn't load your skill sources" error={error} />;
  if (!sources) return <Spinner />;

  return (
    <section data-testid="skill-sources-tab" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Skill sources</h2>
          <p className="text-sm text-muted-foreground">
            Skill packages from skills.sh or GitHub, installed into each conversation’s sandbox at{" "}
            <code className="font-mono text-xs">~/.scooter/skills</code>. Skills you or Scooter put there by hand are
            picked up too. A built-in or personal skill of the same name takes precedence.
          </p>
        </div>
        {!adding && (
          <Button variant="default" size="sm" data-testid="skill-source-new" onClick={() => setAdding(true)}>
            + Add source
          </Button>
        )}
      </div>
      {adding && (
        <SourceForm
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
      {sources.length === 0 ? (
        <p data-testid="skill-sources-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No sources yet. Add one, such as <code className="font-mono text-xs">vercel-labs/agent-skills</code>.
        </p>
      ) : (
        <ul data-testid="skill-source-list" className="flex flex-col gap-2">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onChanged={refresh} />
          ))}
        </ul>
      )}
    </section>
  );
}
