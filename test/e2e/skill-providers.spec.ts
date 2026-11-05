/**
 * Tier 3 E2E for skill providers: echo's sample provider, declared on the k3d render, runs
 * in the conversation's real sandbox and its skill reaches the agent. The fake agent's
 * "~hints <text>" directive reports whether the skills the host wrote contain <text>.
 *
 * Full only: the fast stack has no sandbox to exec into, so it runs no providers.
 */

import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

const MARKER = "echo-provided-skill-marker";

fullOnly("providers exec into a real sandbox")("skill providers", () => {
  test("a provided skill reaches the agent", async ({ chat }) => {
    // A cold sandbox boot, then a turn once the provider can exec into it.
    test.setTimeout(300_000);
    await chat.open();
    await chat.completeTurn("say hello");
    await chat.send(`~hints ${MARKER}`);
    await expect(chat.assistantMessages().last()).toContainText("hints=present", { timeout: 60_000 });
  });

  test("the directive is not fooled by text no skill contains", async ({ chat }) => {
    test.setTimeout(300_000);
    await chat.open();
    await chat.completeTurn("say hello");
    await chat.send("~hints no-skill-says-this-0b7c");
    await expect(chat.assistantMessages().last()).toContainText("hints=absent", { timeout: 60_000 });
  });
});
