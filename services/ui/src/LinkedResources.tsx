/**
 * Linked-resources panel — the external resources (GitHub PR / GitLab MR / Slack
 * thread / Jira ticket) a conversation came from, shown under a collapsible tab.
 *
 * The links arrive on the conversation-list stream, via the session store.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { ConversationLink } from "./client.js";
import { useSessions } from "./sessions.js";
import { SourceBadge } from "./sourceIcon.js";
import { Button } from "@/components/ui/button";

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

const NO_LINKS: ConversationLink[] = [];

export function LinkedResources() {
  const { sessions, currentId } = useSessions();
  const current = sessions.find((x) => x.id === currentId);
  // Keyed by conversation so the remount drops a manual toggle per thread.
  return <LinkedResourcesPanel key={currentId ?? "new"} links={current?.links ?? NO_LINKS} />;
}
