/**
 * Linked-resources panel — the external resources (GitHub PR / GitLab MR / Slack
 * thread / Jira ticket) a conversation came from, shown under a collapsible tab.
 *
 * The links are pushed to the agent-host by the webhooks service on create and
 * served at GET /conversations/:id/links. We poll lightly so a link that arrives
 * after the conversation opens still appears.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "@/icons";

import { loadLinks, type ConversationLink } from "./client.js";
import { useSessions, currentConversation } from "./sessions.js";
import { SourceBadge } from "./sourceIcon.js";
import { Button } from "@/components/ui/button";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

function linkLabel(l: ConversationLink): string {
  if (l.title) return l.title;
  const kind = l.resourceType.replace(/_/g, " ");
  return `${l.source} ${kind}`;
}

/** At/above this many links the panel starts collapsed (it shares the column with the session list). */
export const AUTO_COLLAPSE_AT = 5;

/** Pure in `links` so the collapse rule is testable without the fetch. */
export function LinkedResourcesPanel({ links }: { links: ConversationLink[] }) {
  // null = no user choice yet; a click pins a boolean so a later poll can't re-collapse what the user opened.
  const [open, setOpen] = useState<boolean | null>(null);
  if (links.length === 0) return null;
  const isOpen = open ?? links.length < AUTO_COLLAPSE_AT;

  return (
    <div className="border-t text-sm" data-testid="linked-resources">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-between text-muted-foreground"
        onClick={() => setOpen(!isOpen)}
        data-testid="linked-resources-toggle"
        aria-expanded={isOpen}
      >
        <span>Linked ({links.length})</span>
        {isOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
      </Button>
      {isOpen && (
        <ul className="px-2 pb-2">
          {links.map((l, i) => (
            <li key={`${l.source}-${l.resourceType}-${i}`} data-testid="linked-resource">
              {l.url ? (
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                  title={linkLabel(l)}
                >
                  <SourceBadge source={l.source} />
                  <span className="truncate">{linkLabel(l)}</span>
                </a>
              ) : (
                <span className="flex items-center gap-2 px-2 py-1" title={linkLabel(l)}>
                  <SourceBadge source={l.source} />
                  <span className="truncate">{linkLabel(l)}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LinkedResources() {
  // The effect keys off the server id, not the session key, which is a local placeholder that does not change when the real id arrives.
  useSessions();
  const serverId = currentConversation()?.serverId();
  const [links, setLinks] = useState<ConversationLink[]>([]);

  useEffect(() => {
    setLinks([]); // clear when switching conversations
    // Before creation there is nothing to fetch and no reason to start the interval.
    if (serverId === undefined) return;
    let cancelled = false;
    const refresh = () =>
      void loadLinks({ baseUrl: BASE_URL }, serverId).then((ls) => {
        if (!cancelled) setLinks(ls);
      });
    refresh();
    const t = setInterval(refresh, 10000); // a late-arriving link still shows
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [serverId]);

  // Keyed by conversation so the remount drops a manual toggle per thread.
  return <LinkedResourcesPanel key={serverId ?? "new"} links={links} />;
}
