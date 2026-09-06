/**
 * Published-shares panel — the static pages Scooter published from this conversation,
 * each a stable /s/<uuid>/ link that persists past the session. Rendered as the
 * right-panel "Shares" tab.
 *
 * Data path: the browser has no sandbox SA token, so it can't call the broker's
 * /shares directly. `loadShares` hits the agent-host proxy (GET
 * /conversations/:id/shares), which relays to the broker under its own control SA
 * (scoped to this conversation's short-id). `configured:false` means the broker path
 * isn't wired (local/fake) — RightPanel hides the tab then.
 */

import { useEffect, useState } from "react";

import { useSessions, currentConversation } from "./sessions.js";
import { loadShares, type ShareView } from "./client.js";
import { agentHostConfig } from "./config.js";

export type { ShareView } from "./client.js";

/** Poll the current conversation's published static shares (a late publish still shows).
 *  Returns the list plus `configured` (false = broker path off, so the tab is hidden). */
export function useShares(): { shares: ShareView[]; configured: boolean } {
  const { currentId } = useSessions();
  const [shares, setShares] = useState<ShareView[]>([]);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void currentConversation()
        ?.ifCreated((id) => loadShares(agentHostConfig, id), { configured: false, shares: [] })
        .then((r) => {
          if (cancelled) return;
          setShares(r.shares);
          setConfigured(r.configured);
        });
    setShares([]); // clear when switching conversations
    setConfigured(false);
    refresh();
    const t = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentId]);

  return { shares, configured };
}

/** The Shares tab body: this conversation's published static pages, or an empty state. */
export function PublishedShares({ shares }: { shares: ShareView[] }) {
  if (shares.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="shares-empty">
        No published pages yet. When Scooter publishes a static page, it appears here.
      </p>
    );
  }

  return (
    <ul className="space-y-2 text-sm" data-testid="published-shares">
      {shares.map((s) => (
        <li key={s.uuid} className="flex flex-col">
          <a href={s.url} target="_blank" rel="noreferrer" className="underline">
            {s.description || s.url}
          </a>
          <span className="text-xs text-muted-foreground">
            v{s.latestVersion}
            {s.updatedAt ? ` · updated ${new Date(s.updatedAt).toLocaleString()}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
