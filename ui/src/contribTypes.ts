/**
 * The shapes a contrib's generated UI metadata must satisfy.
 *
 * Hand-written and imported by BOTH sides: contribManifest.generated.ts (so a
 * contrib declaring a malformed row is a tsc error at build time, not a missing
 * glyph at runtime) and the app modules that merge it in. Separate from
 * sourceIcon.tsx only to keep that import acyclic.
 *
 * See contrib/ui-manifest.nix for what generates the manifest, and contrib/
 * submodule.nix (`ui`) for the options a contrib actually writes.
 */

import type { ComponentType } from "react";

/** A react-icons brand mark. */
export type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  className?: string;
  title?: string;
}>;

/** A source's row in the UI's provider table: label + brand mark. */
export interface ContribSource {
  label: string;
  Icon: IconComponent;
  /** Official brand color, or `currentColor` to inherit the theme. */
  color: string;
}

/** How one agent tool renders as a message card. */
export interface ContribToolCard {
  /** The source whose brand row the card wears — a contrib name. */
  provider: string;
  /** Which tool argument holds the text to show. */
  argKey: string;
  /** Short verb for the card header, e.g. "commented on GitLab". */
  action: string;
}
