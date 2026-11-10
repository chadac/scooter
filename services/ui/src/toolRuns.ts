/**
 * Runs of tool calls across messages, for compact density (density.ts). The agent's log
 * gives each tool call its own assistant message, so a stretch of work reads as many
 * messages in a row; compact density shows each such run as one line. A run is a
 * maximal stretch of consecutive assistant messages that hold only tool calls, and the
 * first message in it (the leader) draws the line for all of them.
 */

import { useSyncExternalStore } from "react";

/** The fields of a thread message this reads. */
export interface RunMessage {
  readonly id: string;
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly toolName?: string }[];
  readonly status?: { readonly type: string } | undefined;
}

export interface ToolRun {
  /** The run's first message, which draws its line. */
  leaderId: string;
  isLeader: boolean;
  /** Tool calls in the whole run. */
  count: number;
  /** Distinct tool names in call order, MCP prefixes dropped. */
  names: string[];
  running: boolean;
}

function toolOnly(m: RunMessage | undefined): boolean {
  return m !== undefined && m.role === "assistant" && m.content.length > 0 && m.content.every((p) => p.type === "tool-call");
}

/** Distinct tool names in call order; `mcp__server__tool` reads best as just `tool`. */
export function toolNames(calls: readonly { readonly toolName?: string }[]): string[] {
  const names = calls.flatMap((c) => (c.toolName ? [c.toolName.split("__").pop() || c.toolName] : []));
  return [...new Set(names)];
}

/** The run the message at `index` belongs to, or undefined if it holds anything but tool calls. */
export function toolRunAt(messages: readonly RunMessage[], index: number): ToolRun | undefined {
  if (!toolOnly(messages[index])) return undefined;
  let start = index;
  while (toolOnly(messages[start - 1])) start--;
  let end = index;
  while (toolOnly(messages[end + 1])) end++;

  const run = messages.slice(start, end + 1);
  const calls = run.flatMap((m) => m.content);
  return {
    leaderId: messages[start].id,
    isLeader: start === index,
    count: calls.length,
    names: toolNames(calls),
    running: run.some((m) => m.status?.type === "running"),
  };
}

// Which runs are expanded, by leader id, shared by the leader and its followers.
const open = new Set<string>();
const listeners = new Set<() => void>();

export const toolRunOpen = {
  get: (leaderId: string) => open.has(leaderId),
  toggle(leaderId: string) {
    if (!open.delete(leaderId)) open.add(leaderId);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useToolRunOpen(leaderId: string | undefined): boolean {
  const get = () => (leaderId === undefined ? false : toolRunOpen.get(leaderId));
  return useSyncExternalStore(toolRunOpen.subscribe, get, get);
}
