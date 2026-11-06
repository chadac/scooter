/**
 * The Shares section (`ui.panel`): the static pages Scooter published from this
 * conversation, each a stable /s/<uuid>/ link that outlives the session. It lists them
 * through the agent-host's conversation relay to the broker's
 * `/shares/conversation/<id>/list`, which the relay reaches only after checking the
 * user may see this conversation.
 */

import { useEffect } from "react";

import { conversationFetch, useContribTopic, type PanelProps } from "@/src/contrib/sdk";

/** One published share as this section shows it. */
export interface ShareView {
  uuid: string;
  url: string;
  description: string;
  latestVersion: number;
  updatedAt: string;
}

interface WireShare {
  uuid: string;
  url: string;
  description?: string;
  latest_version?: number;
  updated_at?: string;
}

/** Map the broker's listing body to rows, dropping any without a uuid and url. */
export function parseShares(body: unknown): ShareView[] {
  const rows = (body as { shares?: unknown } | null)?.shares;
  if (!Array.isArray(rows)) return [];
  return (rows as WireShare[])
    .filter((s) => typeof s?.uuid === "string" && typeof s?.url === "string")
    .map((s) => ({
      uuid: s.uuid,
      url: s.url,
      description: s.description ?? "",
      latestVersion: s.latest_version ?? 1,
      updatedAt: s.updated_at ?? "",
    }));
}

async function loadShares(): Promise<ShareView[]> {
  try {
    const res = await conversationFetch("shares", "list");
    if (!res?.ok) return [];
    return parseShares(await res.json());
  } catch {
    return [];
  }
}

const NO_SHARES: ShareView[] = [];

/** Refetched whenever the broker half publishes a change. */
export default function Panel({ setCount }: PanelProps) {
  const value = useContribTopic("shares", { load: loadShares, fallbackPollMs: 10_000 });
  const shares = value ?? NO_SHARES;
  // null until the first read, so the badge hides.
  useEffect(() => setCount(value ? value.length : null), [value, setCount]);

  return <SharesList shares={shares} />;
}

/** This conversation's published pages, or an empty state. */
export function SharesList({ shares }: { shares: ShareView[] }) {
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
