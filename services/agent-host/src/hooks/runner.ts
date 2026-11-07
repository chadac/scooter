/** Runs a conversation's hooks in its sandbox, per Claude Code's protocol. */

import type { ExecBackend } from "../types.js";
import { HOOK_CONDITIONS, HOOK_EVENTS, type HookCondition, type HookDef, type HookEvent, type HookOutcome, type HookRunRecord, type HookRunner } from "./types.js";

/** Hook output reaches the model verbatim, so it is capped. */
const MAX_TEXT = 8_000;

/** AGENT_HOOKS_JSON's well-formed rows. */
export function parseHooks(raw: string | undefined, warn?: (msg: string) => void): HookDef[] {
  if (!raw || !raw.trim()) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    warn?.("AGENT_HOOKS_JSON is not valid JSON; no hooks will run");
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const out: HookDef[] = [];
  for (const r of doc as Array<Partial<HookDef> | null>) {
    if (
      typeof r?.id !== "string" ||
      !r.id ||
      !HOOK_EVENTS.includes(r.event as HookEvent) ||
      typeof r.command !== "string" ||
      !r.command.trim() ||
      !validMatcher(r.matcher ?? "") ||
      (r.when != null && !HOOK_CONDITIONS.includes(r.when as HookCondition))
    ) {
      warn?.(`AGENT_HOOKS_JSON: dropping malformed hook ${JSON.stringify(r?.id ?? null)}`);
      continue;
    }
    out.push({
      id: r.id,
      event: r.event as HookEvent,
      matcher: r.matcher ?? "",
      command: r.command,
      timeoutSec: typeof r.timeoutSec === "number" && r.timeoutSec > 0 ? r.timeoutSec : 30,
      failClosed: r.failClosed === true,
      userCanDisable: r.userCanDisable === true,
      description: typeof r.description === "string" ? r.description : "",
      ...(r.when != null ? { when: r.when as HookCondition } : {}),
    });
  }
  return out;
}

function validMatcher(m: string): boolean {
  try {
    new RegExp(m);
    return true;
  } catch {
    return false;
  }
}

/** Empty or `*` matches all, else an anchored regex. */
export function matches(matcher: string, target: string | undefined): boolean {
  if (matcher === "" || matcher === "*") return true;
  if (target === undefined) return false;
  return new RegExp(`^(?:${matcher})$`).test(target);
}

/** Whether a hook's precondition is met by the event's `scooter` facts. */
export function holds(when: HookCondition | undefined, input: Record<string, unknown>): boolean {
  if (when === undefined) return true;
  const facts = (input.scooter ?? {}) as Record<string, unknown>;
  if (when === "filed") return facts.folder != null;
  return facts[when] === true;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…[truncated]` : s);

interface Answer {
  decision: HookRunRecord["decision"];
  block?: string;
  updatedInput?: Record<string, unknown>;
  context?: string;
  systemMessage?: string;
  stop?: string;
  error?: string;
}

/** Exit 2 blocks with stderr; exit 0 may print JSON. */
export function interpret(event: HookEvent, res: { exitCode: number; stdout: string; stderr: string }): Answer {
  const stdout = res.stdout.trim();
  const stderr = res.stderr.trim();
  if (res.exitCode === 2) return { decision: "block", block: clip(stderr || "blocked by hook") };
  if (res.exitCode !== 0) return { decision: "error", error: clip(stderr || `exit ${res.exitCode}`) };
  let doc: Record<string, unknown> | undefined;
  if (stdout.startsWith("{")) {
    try {
      const v = JSON.parse(stdout);
      if (v && typeof v === "object" && !Array.isArray(v)) doc = v as Record<string, unknown>;
    } catch {
      /* plain text */
    }
  }
  if (!doc) {
    // Claude Code treats plain stdout as context only here.
    const asContext = (event === "UserPromptSubmit" || event === "SessionStart") && stdout;
    return { decision: "allow", ...(asContext ? { context: clip(stdout) } : {}) };
  }
  const spec = (doc.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? clip(v) : undefined);
  const a: Answer = { decision: "allow" };
  a.context = str(spec.additionalContext);
  a.systemMessage = str(doc.systemMessage);
  if (doc.continue === false) {
    a.decision = "stop";
    a.stop = str(doc.stopReason) ?? "stopped by hook";
    return a;
  }
  if (event === "PreToolUse") {
    if (spec.permissionDecision === "deny" || doc.decision === "block") {
      a.decision = "block";
      a.block = str(spec.permissionDecisionReason) ?? str(doc.reason) ?? "denied by hook";
    } else if (spec.updatedInput && typeof spec.updatedInput === "object" && !Array.isArray(spec.updatedInput)) {
      a.updatedInput = spec.updatedInput as Record<string, unknown>;
    }
  } else if (doc.decision === "block") {
    a.decision = "block";
    a.block = str(doc.reason) ?? "blocked by hook";
  }
  return a;
}

/** Any block wins and reasons join; later input rewrites win. */
export function merge(answers: Array<Answer & { id: string }>): Omit<HookOutcome, "runs"> {
  const out: Omit<HookOutcome, "runs"> = { context: [], systemMessages: [] };
  const blocks: string[] = [];
  for (const a of answers) {
    if (a.block) blocks.push(a.block);
    if (a.updatedInput) out.updatedInput = { ...(out.updatedInput ?? {}), ...a.updatedInput };
    if (a.context) out.context.push(a.context);
    if (a.systemMessage) out.systemMessages.push(a.systemMessage);
    if (a.stop) out.stop = out.stop ? `${out.stop}\n${a.stop}` : a.stop;
  }
  if (blocks.length) {
    out.block = blocks.join("\n\n");
    delete out.updatedInput; // a denied call runs with no input at all
  }
  return out;
}

export interface HookRunnerDeps {
  hooks: readonly HookDef[];
  exec: ExecBackend;
  /** Ids the owner turned off, read once per runner. */
  disabled?: () => Promise<ReadonlySet<string>>;
  onRun?: (rec: HookRunRecord) => void;
  cwd?: string;
}

const EMPTY: HookOutcome = { context: [], systemMessages: [], runs: [] };

export function createHookRunner(deps: HookRunnerDeps): HookRunner {
  const cwd = deps.cwd ?? "/workspace";
  let enabled: Promise<HookDef[]> | undefined;
  // A failed lookup keeps every hook on.
  const enabledHooks = () =>
    (enabled ??= (deps.disabled ? deps.disabled().catch(() => new Set<string>()) : Promise.resolve(new Set<string>())).then(
      (off) => deps.hooks.filter((h) => !(h.userCanDisable && off.has(h.id))),
    ));

  const runOne = async (h: HookDef, input: string, signal?: AbortSignal): Promise<Answer & { id: string; rec: HookRunRecord }> => {
    const started = Date.now();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, h.timeoutSec * 1000);
    let a: Answer;
    try {
      const res = await deps.exec.run(
        {
          command: "bash",
          args: ["-c", h.command],
          cwd,
          env: { SCOOTER_HOOK_ID: h.id, SCOOTER_HOOK_EVENT: h.event, CLAUDE_PROJECT_DIR: cwd },
          stdin: input,
        },
        ctl.signal,
      );
      a = timedOut ? { decision: "error", error: `timed out after ${h.timeoutSec}s` } : interpret(h.event, res);
    } catch (err) {
      a = { decision: "error", error: timedOut ? `timed out after ${h.timeoutSec}s` : String((err as Error)?.message ?? err) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (a.decision === "error" && h.failClosed && !signal?.aborted) {
      a = { ...a, decision: "block", block: `Hook ${h.id} failed (${a.error}); it is required, so this is blocked.` };
    }
    const rec: HookRunRecord = { id: h.id, event: h.event, decision: a.decision, ms: Date.now() - started, ...(a.error ? { error: a.error } : {}) };
    deps.onRun?.(rec);
    return { ...a, id: h.id, rec };
  };

  return {
    async has(event) {
      return (await enabledHooks()).some((h) => h.event === event);
    },
    async run(event, input, target, signal) {
      const hooks = (await enabledHooks()).filter((h) => h.event === event && matches(h.matcher, target) && holds(h.when, input));
      if (hooks.length === 0) return EMPTY;
      const payload = JSON.stringify({ cwd, hook_event_name: event, ...input });
      const answers = await Promise.all(hooks.map((h) => runOne(h, payload, signal)));
      return {
        ...merge(answers),
        runs: answers.map((a) => a.rec),
      };
    },
  };
}
