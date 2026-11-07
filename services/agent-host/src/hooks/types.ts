/** Conversation hooks: sandbox scripts speaking Claude Code's hook protocol. */

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** In-process preconditions, so a rare hook costs no sandbox exec. */
export const HOOK_CONDITIONS = ["untitled", "filed"] as const;
export type HookCondition = (typeof HOOK_CONDITIONS)[number];

/** The owner's folder for a conversation, as hooks see it. */
export interface HookFolder {
  id: string;
  name: string;
}

/** One row of AGENT_HOOKS_JSON. */
export interface HookDef {
  /** Stable: user opt-outs are keyed by it. */
  id: string;
  event: HookEvent;
  /** Anchored regex over tool name or session source. */
  matcher: string;
  /** Bash script; the event JSON arrives on stdin. */
  command: string;
  timeoutSec: number;
  /** A crash or timeout blocks instead of being skipped. */
  failClosed: boolean;
  userCanDisable: boolean;
  /** Checked in-process; the hook runs only while it holds. */
  when?: HookCondition;
  description: string;
}

export interface HookRunRecord {
  id: string;
  event: HookEvent;
  decision: "allow" | "block" | "error" | "stop";
  ms: number;
  error?: string;
}

/** Every matching hook's answer, merged. */
export interface HookOutcome {
  /** Why the action is refused (a block or deny). */
  block?: string;
  updatedInput?: Record<string, unknown>;
  /** For the model (`additionalContext`). */
  context: string[];
  /** For the user (`systemMessage`). */
  systemMessages: string[];
  /** A hook ended the turn outright (`continue: false`). */
  stop?: string;
  runs: HookRunRecord[];
}

/** Fires one conversation's hooks. */
export interface HookRunner {
  /** Whether any enabled hook subscribes to `event`. */
  has(event: HookEvent): Promise<boolean>;
  run(event: HookEvent, input: Record<string, unknown>, target?: string, signal?: AbortSignal): Promise<HookOutcome>;
}
