/**
 * Published-shares panel (SCAFFOLD) — the static pages an agent published from
 * this conversation, each a stable /s/<uuid>/ link that persists past the session.
 *
 * ⚠️ PLACEHOLDER: the data source is not wired yet. Two options under discussion,
 * pending the broker `shares` subsystem (services/broker/broker/shares/) and the
 * upcoming declarative schema:
 *
 *   A. Auto-link on publish — the broker attaches each published share to the
 *      conversation via the existing autolink path, so shares already surface in
 *      <LinkedResources/> with a "share" source. If we go this way, this dedicated
 *      panel is unnecessary; delete it and add a SourceBadge for shares instead.
 *   B. Dedicated endpoint — agent-host proxies `GET /shares` (broker, owner-scoped
 *      by the conversation's SA identity) and exposes it to the UI as
 *      `loadShares(conversationId)`. This panel then polls it like LinkedResources.
 *
 * This component intentionally has NO wiring yet (renders null) so it compiles and
 * ships without affecting the app until we pick A or B. Replace `loadShares` with
 * the real client call and mount it in <RightPanel/>.
 */

import { useEffect, useState } from "react";

import { useSessions, currentConversation } from "./sessions.js";
import { Button } from "@/components/ui/button";

export interface PublishedShare {
  uuid: string;
  url: string;
  description: string;
  latestVersion: number;
  updatedAt: string;
}

// TODO(shares): replace with a real agent-host-backed client call (option B) or
// delete this component in favour of LinkedResources (option A).
async function loadShares(_conversationId: string): Promise<PublishedShare[]> {
  return [];
}

export function PublishedShares() {
  const { currentId } = useSessions();
  const [shares, setShares] = useState<PublishedShare[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void currentConversation()
        ?.ifCreated((id) => loadShares(id), [] as PublishedShare[])
        .then((s) => {
          if (!cancelled) setShares(s);
        });
    setShares([]); // clear when switching conversations
    refresh();
    const t = setInterval(refresh, 10000); // a late publish still shows
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentId]);

  if (shares.length === 0) return null; // placeholder: nothing to show until wired

  return (
    <div className="border-t text-sm" data-testid="published-shares">
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
        Published pages ({shares.length})
      </Button>
      {open && (
        <ul className="px-3 pb-2">
          {shares.map((s) => (
            <li key={s.uuid} className="py-1">
              <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                {s.description || s.url}
              </a>
              <span className="ml-2 opacity-60">v{s.latestVersion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
