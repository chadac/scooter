/**
 * Shared mapping from a source (a linked-resource provider, a tool card's provider, or
 * a system event's origin) to a brand icon and label, used by the LinkedResources panel,
 * the sidebar per-conversation icons and the thread's system-event lines. Built-in icons come from `react-icons` (and
 * `lucide-react` for the unbranded platform sources), imported per icon so only the ones
 * used are bundled, and render in the provider's brand color.
 * A contrib adds its own row through the runtime manifest (contribManifest.ts) with
 * its mark as SVG data rather than a component, and BrandMark draws either form.
 */

import type { ComponentType, ReactNode } from "react";
import { GithubMark, Link, SlackMark, SquareTerminal } from "@/icons";
import { ScooterMark } from "@/icons";
// Platform event sources have no brand, so they take a neutral glyph.
import { AlarmClockIcon, BotIcon, CogIcon, KeyRoundIcon, ShieldCheckIcon } from "@/icons";
import type { ContribIcon } from "./contribTypes.js";
import { contribSources } from "./contribManifest.js";

/** A react-icons brand mark, the form a built-in source's mark takes. */
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

/** The app's own sources, as opposed to contribs. */
const BUILTIN_SOURCES: Record<string, SourceRow> = {
  // GitHub's brand black is invisible in dark mode -> inherit the theme color.
  github: { label: "GitHub", mark: GithubMark, color: "currentColor" },
  // Slack's deep aubergine disappears in dark mode -> use a brighter brand accent.
  slack: { label: "Slack", mark: SlackMark, color: "#E01E5A" },
  // Not a linked-resource provider — the shell/command tool card (ToolCallView).
  shell: { label: "Shell", mark: SquareTerminal, color: "currentColor" },
  // Platform sources of system events (SystemEventMessage), not linked-resource providers.
  scheduler: { label: "Scheduler", mark: AlarmClockIcon, color: "currentColor" },
  "background job": { label: "Background job", mark: CogIcon, color: "currentColor" },
  broker: { label: "Broker", mark: KeyRoundIcon, color: "currentColor" },
  subagent: { label: "Subagent", mark: BotIcon, color: "currentColor" },
  hook: { label: "Hook", mark: ShieldCheckIcon, color: "currentColor" },
};

/** Built-ins plus the deployment's contribs merged on top, resolved per call because
 *  the manifest arrives over the network after this module loads. */
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

/** Draw a source's mark: a react-icons component for a built-in, an inline <svg> for
 *  a contrib. */
function BrandMark({
  mark,
  size,
  color,
}: {
  mark: IconComponent | ContribIcon;
  size: number;
  color: string;
}) {
  if (!("path" in mark)) {
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

/** The Scooter mark, the "show the conversation title" option in the Show control. */
export function TitleBadge({ size = 15 }: { size?: number }) {
  return (
    <span
      data-testid="title-icon"
      title="Conversation title"
      aria-label="Conversation title"
      className="inline-flex items-center justify-center leading-none"
    >
      <ScooterMark style={{ width: size, height: size }} aria-hidden />
    </span>
  );
}

/** A small brand icon for a linked-resource provider. */
export function SourceBadge({
  source,
  size = 14,
  fallback = <Link className="size-3.5" aria-hidden />,
}: {
  source: string;
  size?: number;
  /** What an unknown source shows instead of a mark. */
  fallback?: ReactNode;
}) {
  const meta = sources()[source];
  if (!meta) {
    return (
      <span
        data-testid="source-icon"
        data-source={source}
        title={source}
        aria-label={source}
        className="inline-flex items-center text-muted-foreground"
      >
        {fallback}
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
