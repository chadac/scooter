/**
 * The supported surface for contrib UI code (contrib/<name>/ui/*.tsx: settings tabs,
 * interrupt renderers, right-panel tabs and fenced-block renderers). Such a module may
 * import only from here, @/components/*, @/lib/* and services/ui/package.json deps; the
 * ESLint rule in services/ui/eslint.config.js enforces it.
 * Anything a module needs from the app belongs here, so
 * the app's internals can change without breaking contribs.
 */

import { currentConversation, useCurrentUser, useSessions } from "../sessions.js";

export { Button } from "@/components/ui/button";
export { Spinner } from "@/components/ui/spinner";
export { EmptyState } from "@/components/ui/empty-state";
export { ErrorState } from "@/components/ui/error-state";
export { cn } from "@/lib/utils";

/** The signed-in caller, as the header badge shows it. */
export interface Whoami {
  id: string;
  email: string | null;
  anonymous: boolean;
}

/** The signed-in caller from /whoami. */
export function useWhoami(): Whoami {
  return useCurrentUser();
}

/** Class strings for form controls, matching the built-in settings tabs. */
export const inputClass = "rounded-md border border-input bg-background px-2 py-1.5 text-sm";
export const monoInputClass = "rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm";
export const textareaClass =
  "min-h-24 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/**
 * Call this contrib's broker routes as the signed-in user. Needs `api = true` on the
 * tab's `ui.settingsTabs` row. `contribFetch("echo", "whoami")` reaches the broker's
 * `/echo/user/whoami`; the agent-host names the user, so the route never trusts
 * anything the tab sends about who it is. A plain `fetch` Response comes back: 401
 * when signed out, 404 when the contrib has no relay, and otherwise the route's own
 * status. A JSON body is sent with its content type when `init.json` is set.
 */
export function contribFetch(
  contrib: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const url = `${BASE_URL}/contrib-api/${encodeURIComponent(contrib)}/${path.replace(/^\/+/, "")}`;
  return fetch(url, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
}

/**
 * GET this contrib's broker routes for the open conversation, as the signed-in user.
 * Needs `api = true` on the contrib's `ui.panel`. `conversationFetch("shares", "list")`
 * reaches the broker's `/shares/conversation/<id>/list` once the agent-host has checked
 * the user may see the conversation. Resolves null before the conversation exists on
 * the server, so a panel shows its empty state without a request.
 */
export function conversationFetch(contrib: string, path: string): Promise<Response | null> {
  const url = currentConversation()?.url(
    `/contrib-api/${encodeURIComponent(contrib)}/${path.replace(/^\/+/, "")}`,
  );
  if (!url) return Promise.resolve(null);
  return fetch(url, { credentials: "same-origin" });
}

/** Changes when the user opens another conversation, for a panel's effect deps. */
export function useConversationKey(): string {
  return useSessions().currentId;
}

/** What a contrib's right-panel tab (its `ui.panel` entry) receives. */
export interface PanelProps {
  /** Set the tab's badge; 0 or null hides it. */
  setCount(count: number | null): void;
}

/** What a contrib's fenced-block renderer (a `ui.markdownFences` entry) receives. */
export interface MarkdownFenceProps {
  /** The text inside the fence. */
  body: string;
}

export { useRequestDraft } from "../approvalFocus.js";

/**
 * Where a request is drawn: `brief` is the narrow Approvals-tab card, enough to decide
 * the common case; `detail` is the central column, with room for everything.
 */
export type ApprovalView = "brief" | "detail";

/** One answer the request offers, e.g. Approve or Deny. */
export interface InterruptOption {
  optionId: string;
  name: string;
  kind: string;
}

/** An option this viewer may not use, with the words to explain why. */
export interface BlockedOption {
  optionId: string;
  title: string;
  hint: string;
}

/** What an interrupt renderer (a contrib's `ui.interruptRenderers` entry) receives for one pending request. */
export interface InterruptRendererProps {
  /** The request's heading. */
  message: string;
  /** The request's data as the agent sent it, unvalidated: the renderer checks its own shape and throws on one it cannot draw. */
  data: unknown;
  /** Which of the two views to draw. A renderer may ignore it and draw one card for both. */
  view: ApprovalView;
  /** True while an answer is being sent. */
  busy: boolean;
  /** The answers the request offers; a question-style request has one, an approval two. */
  options: InterruptOption[];
  /** Set when the host says this viewer may not use one of `options`. */
  blocked?: BlockedOption;
  /** Answer with the first option and a JSON result, which the agent receives. */
  resolve(result: Record<string, unknown>): void;
  /** Answer with a named option, e.g. "approve" or "deny". */
  choose(optionId: string, result?: Record<string, unknown>): void;
  /** Dismiss without answering; the agent is told the user did not answer. */
  dismiss(): void;
}

/** A settings tab for linking the user's forge account (scooter_broker_lib.user_auth). */
export { LinkedAccountTab, type LinkedAccountTabProps } from "./LinkedAccountTab.js";
