/**
 * Turning a question card's answers into a prompt for a run that no longer holds the question.
 */

import { describe, it, expect } from "vitest";

import { orphanedAnswerPrompt } from "../../src/session/orphanedAnswer.js";

describe("orphanedAnswerPrompt", () => {
  it("lists each question with its answer", () => {
    const text = orphanedAnswerPrompt({ answers: { "Which DB?": "Postgres", "Deploy now?": "Yes" } });
    expect(text).toContain("Q: Which DB?\nA: Postgres");
    expect(text).toContain("Q: Deploy now?\nA: Yes");
  });

  it("undefined without an answers map", () => {
    expect(orphanedAnswerPrompt(undefined)).toBeUndefined();
    expect(orphanedAnswerPrompt({})).toBeUndefined();
    expect(orphanedAnswerPrompt({ answers: ["x"] })).toBeUndefined();
  });

  it("skips blank and non-string answers", () => {
    expect(orphanedAnswerPrompt({ answers: { a: "", b: 3 } })).toBeUndefined();
    expect(orphanedAnswerPrompt({ answers: { a: " ", b: "ok" } })).toBe(
      "Answering the question you asked earlier (the run that asked it ended before I replied):\n\nQ: b\nA: ok",
    );
  });
});
