/**
 * Shared mapping from a linked-resource provider (`ConversationLink.source`) to
 * a real brand icon + label. Used by both the LinkedResources panel and the
 * sidebar per-conversation icons.
 *
 * Built-in icons are from `react-icons/si` (Simple Icons — free brand SVGs),
 * imported per-icon so only the ones we use are bundled. Each renders in the
 * provider's official brand color.
 *
 * A CONTRIB adds its own row through the RUNTIME manifest (contribManifest.ts)
 * rather than by editing this file, and its mark arrives as SVG data rather than
 * as a component — per-icon imports are exactly why: a runtime name like
 * "SiGrafana" could only resolve by bundling all of react-icons. BrandMark below
 * draws either form. Why: PR #601.
 */

import type { ComponentType } from "react";
import { SiGithub } from "react-icons/si";
// Simple Icons dropped the Slack mark (trademark); FontAwesome still ships it.
import { FaSlack, FaTerminal } from "react-icons/fa";
// The Scooter mark — used for the "show the conversation TITLE" option (Scooter's
// own name for a chat, vs. a provider's linked-resource name).
import { MdElectricScooter } from "react-icons/md";
import type { ContribIcon } from "./contribTypes.js";
import { contribSources } from "./contribManifest.js";

/** A react-icons brand mark — how a BUILT-IN source draws itself. */
export type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  className?: string;
  title?: string;
}>;

/** One source's row, whichever form its mark came in. */
interface SourceRow {
  label: string;
  color: string;
  mark: IconComponent | ContribIcon;
}

/** The app's own sources: the ones that are not contribs (yet). */
const BUILTIN_SOURCES: Record<string, SourceRow> = {
  // GitHub's brand black is invisible in dark mode -> inherit the theme color.
  github: { label: "GitHub", mark: SiGithub, color: "currentColor" },
  // Slack's deep aubergine also disappears in dark mode -> use a brighter brand
  // accent that reads on both themes.
  slack: { label: "Slack", mark: FaSlack, color: "#E01E5A" },
  // Not a linked-resource provider — the shell/command tool card (ToolCallView).
  shell: { label: "Shell", mark: FaTerminal, color: "currentColor" },
};

/** Built-ins plus the deployment's contribs, which merge ON TOP: a deployment
 *  that swaps an integration for its own contrib of the same name gets that
 *  contrib's brand row. Resolved per CALL, never captured in a module const —
 *  the manifest arrives over the network after this module loads. Why: PR #601. */
function sources(): Record<string, SourceRow> {
  const merged: Record<string, SourceRow> = { ...BUILTIN_SOURCES };
  for (const [name, s] of Object.entries(contribSources())) {
    merged[name] = { label: s.label, color: s.color, mark: s.icon };
  }
  return merged;
}

export function sourceLabel(source: string): string {
  return sources()[source]?.label ?? source;
}

/** Draw a source's mark: a react-icons component (built-in) or an inline <svg>
 *  (a contrib, whose icon is data because the manifest is fetched at runtime). */
function BrandMark({
  mark,
  size,
  color,
}: {
  mark: IconComponent | ContribIcon;
  size: number;
  color: string;
}) {
  if (typeof mark === "function") {
    const Icon = mark;
    return <Icon size={size} color={color} />;
  }
  return (
    <svg
      viewBox={mark.viewBox}
      width={size}
      height={size}
      fill={color}
      aria-hidden="true"
      focusable="false"
    >
      <path d={mark.path} />
    </svg>
  );
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
  const meta = sources()[source];
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
  const { mark, label, color } = meta;
  return (
    <span
      data-testid="source-icon"
      data-source={source}
      title={label}
      aria-label={label}
      className="inline-flex items-center"
    >
      <BrandMark mark={mark} size={size} color={color} />
    </span>
  );
}
