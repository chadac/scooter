// A settings tab for linking the user's forge account (scooter_broker_lib.user_auth):
// connect through OAuth, paste a personal access token instead, or unlink.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";
import { contribFetch, monoInputClass } from "./sdk.js";

interface Account {
  connected: boolean;
  oauth: boolean;
  kind?: "oauth" | "pat";
  login?: string;
  name?: string;
  email?: string;
  broken?: boolean;
}

export interface LinkedAccountTabProps {
  /** The contrib whose broker routes serve /user/account, /user/connect, /user/pat. */
  contrib: string;
  /** "GitHub", "GitLab". */
  label: string;
  /** What linking lets Scooter do, shown above the controls. */
  description: ReactNode;
  /** Shown beside the token field, e.g. which scopes a PAT needs. */
  patHint?: ReactNode;
}

export function LinkedAccountTab({ contrib, label, description, patHint }: LinkedAccountTabProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (path: string, init?: RequestInit & { json?: unknown }) => {
      const res = await contribFetch(contrib, path, init);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as Account & { url?: string };
    },
    [contrib],
  );

  const load = useCallback(async () => {
    try {
      setAccount(await call("account"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !account) return <ErrorState title={`Couldn't load your ${label} account`} error={error} />;
  if (!account) return <Spinner />;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    act(async () => {
      const { url } = await call("connect", { method: "POST" });
      if (url) window.location.assign(url);
    });
  const savePat = () =>
    act(async () => {
      setAccount(await call("pat", { method: "POST", json: { token } }));
      setToken("");
    });
  const unlink = () =>
    act(async () => {
      if (!window.confirm(`Unlink your ${label} account? Scooter will act as itself again.`)) return;
      setAccount(await call("account", { method: "DELETE" }));
    });

  return (
    <div className="space-y-4" data-testid={`${contrib}-linked-account`}>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{label}</h2>
        <div className="text-sm text-muted-foreground">{description}</div>
      </section>

      {account.connected ? (
        <section className="space-y-2">
          <p className="text-sm" data-testid={`${contrib}-account-status`}>
            Linked as <strong>{account.login}</strong>
            {account.kind === "pat" ? " with a personal access token" : ""}.
          </p>
          {account.broken ? (
            <p className="text-sm text-destructive">
              {label} no longer accepts this link, so Scooter is acting as itself. Reconnect to fix it.
            </p>
          ) : null}
          <div className="flex gap-2">
            {account.oauth && (account.broken || account.kind === "pat") ? (
              <Button size="sm" onClick={connect} disabled={busy}>Reconnect</Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={unlink} disabled={busy}>Unlink</Button>
          </div>
        </section>
      ) : (
        <section className="space-y-3">
          {account.oauth ? (
            <Button size="sm" onClick={connect} disabled={busy}>Connect {label}</Button>
          ) : null}
          <div className="space-y-1">
            <p className="text-sm">{account.oauth ? "Or use a personal access token:" : "Personal access token:"}</p>
            <div className="flex gap-2">
              <input
                aria-label={`${label} personal access token`}
                type="password"
                autoComplete="off"
                className={`${monoInputClass} flex-1`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button size="sm" variant="outline" onClick={savePat} disabled={busy || !token.trim()}>Save</Button>
            </div>
            {patHint ? <p className="text-xs text-muted-foreground">{patHint}</p> : null}
          </div>
        </section>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
