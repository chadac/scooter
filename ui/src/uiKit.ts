/**
 * `@scooter/ui-kit` — the ONLY surface a contrib's UI code may import.
 *
 * A contrib's panel is compiled into this bundle, so without a declared surface
 * it could reach any app module by relative path and couple itself to internals
 * that are free to change. This re-exports the subset contribs may rely on, so
 * "what can a contrib use?" has a grep-able answer and widening it is a reviewed
 * edit rather than a deep import nobody notices.
 *
 * It is deliberately NOT an npm package. `ui/default.nix` pins `npmDepsHash`, so
 * a contrib that could bring its own dependency would change the UI's lockfile —
 * which is the same "adding a contrib edits the app" problem, relocated. Contribs
 * compose from what the UI already bundles; `react` resolves for them because
 * their source is overlaid into this tree.
 *
 * See contrib/README.md and contrib/ui-manifest.nix.
 */

// React itself: a contrib writes hooks and components like any other module.
export {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
export type { ComponentType, ReactNode } from "react";

// The shapes a panel must satisfy — a contrib types its own `usePanel` against
// this, so a mismatch is a tsc error at UI build time.
export type { ContribPanel, ContribSource, ContribToolCard } from "./contribTypes.js";

// Which conversation is on screen, and how to talk to the agent-host about it.
// A contrib's panel is conversation-scoped: this is how it knows what to load
// and when to reload (`currentId` changes on every conversation switch).
export { useSessions, currentConversation } from "./sessions.js";
export { agentHostConfig } from "./config.js";
export type { AgentHostConfig } from "./client.js";

// A contrib's panel reads its OWN agent-host route through this rather than the
// app exporting a loader per feature. Best-effort by contract: a 501 means the
// feature is not wired in this deployment, which is how a panel knows to hide.
export { agentHostGet } from "./client.js";

// Design-system primitives, so a contrib's panel looks like the rest of the app
// instead of re-implementing a button.
export { Button } from "@/components/ui/button";
export { cn } from "@/lib/utils";
