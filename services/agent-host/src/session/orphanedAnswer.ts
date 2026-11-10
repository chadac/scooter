/**
 * An answer (to a question or a choice) that arrives after the run that asked it is gone (a rollout or
 * hand-off killed it) has nothing to unblock, so it is delivered as a new prompt instead.
 */

import type { AguiInterrupt } from "../bridge.js";

/** The prompt carrying a question card's `{ answers }` result, or undefined when there is none. */
export function orphanedAnswerPrompt(result: Record<string, unknown> | undefined): string | undefined {
  const answers = result?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  const pairs = Object.entries(answers).filter(([, a]) => typeof a === "string" && a.trim() !== "");
  if (pairs.length === 0) return undefined;
  return [
    "Answering the question you asked earlier (the run that asked it ended before I replied):",
    ...pairs.map(([q, a]) => `Q: ${q}\nA: ${a}`),
  ].join("\n\n");
}

/** The prompt carrying an option picked on an orphaned choice card, or undefined if unknown. */
export function orphanedChoicePrompt(interrupt: AguiInterrupt, optionId: string): string | undefined {
  const options = Array.isArray(interrupt.metadata?.options) ? interrupt.metadata.options : [];
  const picked = options.find((o) => (o as { optionId?: unknown } | null)?.optionId === optionId) as
    | { name?: unknown }
    | undefined;
  if (!picked) return undefined;
  const label = typeof picked.name === "string" && picked.name ? picked.name : optionId;
  const asked = interrupt.message ? ` (${interrupt.message})` : "";
  return `Answering the choice you asked for earlier${asked}, whose run ended before I replied. I picked: ${label}`;
}
