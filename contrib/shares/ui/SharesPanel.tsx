/**
 * The Shares tab: the static pages Scooter published from this conversation,
 * each a stable /s/<uuid>/ link that persists past the session.
 *
 * Data path: the browser has no sandbox SA token, so it cannot call the broker's
 * /shares directly. It reads the agent-host proxy (GET /conversations/:id/shares),
 * which relays to the broker under its own control SA, scoped to this
 * conversation. A 501 means the broker path is not wired (local/fake) — the tab
 * hides rather than showing an empty list, which is what `show` is for.
 */

import {
  agentHostConfig,
  agentHostGet,
  currentConversation,
  useEffect,
  useSessions,
  useState,
  type ContribPanel,
} from "@scooter/ui-kit";

/** One published share, as the broker's snake_case summary arrives. */
interface ShareRow {
  uuid: string;
  url: string;
  description?: string;
  latest_version?: number;
  updated_at?: string;
}

interface SharesBody {
  configured?: boolean;
  shares?: ShareRow[];
}

const POLL_MS = 10000;

/** Poll this conversation's published shares. A late publish still shows. */
function useShares(): { shares: ShareRow[]; configured: boolean } {
  const { currentId } = useSessions();
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void currentConversation()
        ?.ifCreated(
          (id) => agentHostGet<SharesBody>(agentHostConfig, `/conversations/${encodeURIComponent(id)}/shares`),
          null,
        )
        .then((r) => {
          if (cancelled || r === null) return;
          // `configured: false` is the 501 shape — the feature is off here.
          if ("configured" in r && r.configured === false) {
            setConfigured(false);
            setShares([]);
            return;
          }
          const body = r as SharesBody;
          setConfigured(body.configured ?? true);
          setShares(body.shares ?? []);
        });
    setShares([]); // clear when switching conversations
    setConfigured(false);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentId]);

  return { shares, configured };
}

function SharesList({ shares }: { shares: ShareRow[] }) {
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
            v{s.latest_version ?? 1}
            {s.updated_at ? ` · updated ${new Date(s.updated_at).toLocaleString()}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The tab: one subscription, feeding both the count badge and the body. */
export const usePanel: ContribPanel["usePanel"] = () => {
  const { shares, configured } = useShares();
  return { show: configured, count: shares.length, body: <SharesList shares={shares} /> };
};
