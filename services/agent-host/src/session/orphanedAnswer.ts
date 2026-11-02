/**
 * A question's answer that arrives after the run that asked it is gone (a rollout or
 * hand-off killed it) has nothing to unblock, so it is delivered as a new prompt instead.
 */

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
