// Settings → API keys: create, list and revoke the keys local agents use.
//
// Calls go through contribFetch, relayed to /apikeys/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, contribFetch, EmptyState, ErrorState, Spinner, inputClass, monoInputClass } from "@/src/contrib/sdk";

interface Key {
  key_id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
}

interface Listing {
  keys: Key[];
  limit: number;
  max_days: number;
}

const EXPIRY_DAYS = [30, 90, 365];

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await contribFetch("apikeys", path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
const day = (iso: string) => new Date(iso).toLocaleDateString();

export default function ApiKeysSettingsTab() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setListing(await call<Listing>("keys"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState title="Couldn't load your API keys" error={error} />;
  if (!listing) return <Spinner />;

  const create = async () => {
    setBusy(true);
    try {
      const key = await call<Key & { key: string }>("keys", {
        method: "POST",
        json: { name: name.trim(), expires_in_days: days, scopes: readOnly ? ["read"] : ["read", "write"] },
      });
      setCreated(key.key);
      setCopied(false);
      setName("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (key: Key) => {
    if (!window.confirm(`Revoke "${key.name}"? Agents using it stop working within 30 seconds.`)) return;
    try {
      await call(`keys/${encodeURIComponent(key.key_id)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(String(e));
    }
  };
  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created);
    setCopied(true);
  };
  const full = listing.keys.length >= listing.limit;

  return (
    <div className="space-y-4" data-testid="apikeys-settings-tab">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">API keys</h2>
        <p className="text-sm text-muted-foreground">
          A key lets a local agent, such as the <code>scooter</code> CLI, Claude Code with scooter-skills, or
          scooter-mode, start and follow your conversations without a browser session. It acts as you, but only on
          conversations you own. It can answer an agent's questions but never approve requests, which stay in the web
          UI. Read-only keys can list and follow conversations but not start or message them.
        </p>
      </section>

      {created && (
        <section className="space-y-2 rounded-md border border-input p-3" data-testid="apikeys-new-key">
          <p className="text-sm font-medium">Copy your new key now. It won't be shown again.</p>
          <input
            aria-label="New API key"
            className={`${monoInputClass} w-full`}
            readOnly
            value={created}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy key"}</Button>
            <Button size="sm" variant="outline" onClick={() => setCreated(null)}>Done</Button>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">New key</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Key name"
            className={`${inputClass} min-w-48 flex-1`}
            placeholder="Name, e.g. laptop"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Expires after"
            className={inputClass}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {EXPIRY_DAYS.filter((d) => d <= listing.max_days).map((d) => (
              <option key={d} value={d}>
                Expires in {d} days
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Read-only
          </label>
          <Button size="sm" onClick={create} disabled={busy || full || !name.trim()}>
            {busy ? "Creating…" : "Create key"}
          </Button>
        </div>
        {full && (
          <p className="text-xs text-muted-foreground">
            You have {listing.limit} keys, the most allowed. Revoke one to create another.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Your keys</h3>
        {listing.keys.length === 0 ? (
          <EmptyState title="No API keys yet" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-input" data-testid="apikeys-keys">
            {listing.keys.map((k) => (
              <li key={k.key_id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">
                    {k.name} <span className="font-mono text-xs text-muted-foreground">sct_{k.key_id}_…</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {k.scopes.includes("write") ? "Read and write" : "Read-only"} · created {day(k.created_at)} ·
                    expires {day(k.expires_at)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last used {when(k.last_used_at)}
                    {k.last_used_ip ? ` from ${k.last_used_ip}` : ""}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => revoke(k)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
