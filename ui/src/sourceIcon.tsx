/**
 * Shared mapping from a linked-resource provider (`ConversationLink.source`) to
 * a real brand icon + label. Used by both the LinkedResources panel and the
 * sidebar per-conversation icons.
 *
 * Icons are from `react-icons/si` (Simple Icons — free brand SVGs), imported
 * per-icon so only the ones we use are bundled. Each renders in the provider's
 * official brand color.
 */

import type { ComponentType } from "react";
import { SiGithub, SiGitlab, SiJira } from "react-icons/si";
// Simple Icons dropped the Slack mark (trademark); FontAwesome still ships it.
import { FaSlack, FaTerminal } from "react-icons/fa";
// The Scooter mark — used for the "show the conversation TITLE" option (Scooter's
// own name for a chat, vs. a provider's linked-resource name).
import { MdElectricScooter } from "react-icons/md";

interface SourceMeta {
  label: string;
  Icon: ComponentType<{ size?: number; color?: string; className?: string; title?: string }>;
  /** Official brand color. */
  color: string;
}

const SOURCES: Record<string, SourceMeta> = {
  // GitHub's brand black is invisible in dark mode -> inherit the theme color.
  github: { label: "GitHub", Icon: SiGithub, color: "currentColor" },
  gitlab: { label: "GitLab", Icon: SiGitlab, color: "#FC6D26" },
  // Slack's deep aubergine also disappears in dark mode -> use a brighter brand
  // accent that reads on both themes.
  slack: { label: "Slack", Icon: FaSlack, color: "#E01E5A" },
  jira: { label: "Jira", Icon: SiJira, color: "#0052CC" },
  // Not a linked-resource provider — the shell/command tool card (ToolCallView).
  shell: { label: "Shell", Icon: FaTerminal, color: "currentColor" },
};

export function sourceLabel(source: string): string {
  return SOURCES[source]?.label ?? source;
}

/** The Scooter mark — the "show the conversation title" option in the Show control
 *  (Scooter names the chat, vs. a provider's linked-resource name). */
export function TitleBadge({ size = 15 }: { size?: number }) {
  return (
    <span
      data-testid="title-icon"
      title="Conversation title"
      aria-label="Conversation title"
      className="inline-flex items-center"
    >
      <MdElectricScooter size={size} color="currentColor" />
    </span>
  );
}

/** A small brand icon for a linked-resource provider. */
export function SourceBadge({ source, size = 14 }: { source: string; size?: number }) {
  const meta = SOURCES[source];
  if (!meta) {
    // Unknown provider — a neutral link glyph + the raw name as a label.
    return (
      <span
        data-testid="source-icon"
        data-source={source}
        title={source}
        aria-label={source}
        className="inline-flex items-center text-muted-foreground"
      >
        🔗
      </span>
    );
  }
  const { Icon, label, color } = meta;
  return (
    <span
      data-testid="source-icon"
      data-source={source}
      title={label}
      aria-label={label}
      className="inline-flex items-center"
    >
      <Icon size={size} color={color} />
    </span>
  );
}
