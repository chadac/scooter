/**
 * E2E (fast+full) — an agent-posted ```scooter-embed block renders as a sandboxed iframe.
 *
 * Getting a MULTI-LINE fenced block into an ASSISTANT message deterministically: the
 * `!<cmd>` harness runs a real shell command and pipes its stdout into the assistant
 * reply (the same path the other specs drive with `!echo`). The fake agent wraps that
 * stdout as:  🤖 (dummy agent) ran `<cmd>` (exit 0):\n<stdout>  — so the fence has to
 * survive that prefix. Two things make it robust:
 *   - the command text is echoed INSIDE an inline-code span in the prefix line, so the
 *     command must contain NO literal backtick or it would unbalance that span and
 *     swallow the fence. We therefore emit the fence's backticks from OCTAL (\140) via
 *     a command substitution — the command text stays backtick-free, the *output* is a
 *     real ```-fence.
 *   - a fenced code block legitimately interrupts the preceding paragraph (CommonMark),
 *     so the prefix line and the fence parse as separate blocks.
 * Only assistant messages run MarkdownText, and MarkdownText turns the fence into the
 * iframe — so this drives the real render path added in #393 through browser + UI +
 * agent-host. `sendTurn` waits for the reply to actually land, so a run that never
 * completes fails fast rather than as a slow iframe-visibility timeout.
 *
 * The FULL end-to-end (an agent PUBLISHES a static file via `agent-broker shares`, then
 * embeds the returned UUID, and the iframe actually serves that file) needs the broker's
 * `shares` subsystem enabled in-cluster — see the fullOnly block, which self-skips until
 * #389's deployment wiring lands.
 */

import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

const UUID = "7f3c2a1e-1b2c-4d5e-8f90-abcdef012345";

// A shell fragment that prints three backticks via octal escape — keeps LITERAL
// backticks out of the command text (which the fake agent echoes inside an inline-code
// span) while still emitting a real ```-fence in the command's stdout.
const BT = `"$(printf '\\140\\140\\140')"`;

/** A `!printf` whose stdout is a scooter-embed fence (one line per arg). */
function embedCmd(share: string, ...extra: string[]): string {
  const args = [`${BT}scooter-embed`, `'share: ${share}'`, ...extra.map((e) => `'${e}'`), BT];
  return `!printf '%s\\n' ${args.join(" ")}`;
}

test.describe("share embed markdown block", () => {
  test.setTimeout(120_000);

  test("an assistant scooter-embed block renders a sandboxed iframe", async ({ chat, page }) => {
    await chat.open();
    // sendTurn waits until THIS turn's assistant reply has landed (run completed).
    await chat.sendTurn(embedCmd(UUID, "width: 400", "center: true"), 90_000);

    // The fence is replaced by <ShareEmbed> — assert the iframe, not the raw text.
    const frame = page.locator('[data-testid="share-embed"] iframe');
    await expect(frame).toBeVisible({ timeout: 30_000 });

    // src is rebuilt from the validated UUID as a /s/<uuid>/ path — never external.
    await expect(frame).toHaveAttribute("src", new RegExp(`/s/${UUID}/$`));

    // Security invariants: sandboxed, and NOT same-origin.
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  test("a non-share reference renders an error, not an iframe", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn(embedCmd("https://evil.example.com/"), 90_000);
    await expect(page.locator('[data-testid="share-embed-error"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="share-embed"] iframe')).toHaveCount(0);
  });
});

// The real publish -> embed -> serve loop. Runs only on the full (real-cluster) target
// AND only when the broker actually has `shares` enabled, so it never reds CI before the
// deployment wiring lands; once shares ships it validates the whole flow.
fullOnly("needs the broker shares subsystem enabled in-cluster")("share embed full flow", () => {
  test.setTimeout(240_000);

  test("agent publishes a static file, embeds it, and the iframe serves it", async ({ chat, page }) => {
    await chat.open();

    // Publish a one-file share through the real broker via the `!` exec harness.
    const html = "<h1 id=embed-marker>hello from a published share</h1>";
    const b64 = Buffer.from(html).toString("base64");
    await chat.sendTurn(
      `!agent-broker shares -X POST -H 'Content-Type: application/json' ` +
        `-d '{"files":{"index.html":{"content_type":"text/html","b64":"${b64}"}}}'`,
      120_000,
    );

    // If shares isn't enabled the POST 404s → skip rather than fail.
    const reply = chat.assistantMessages().last();
    const m = (await reply.innerText()).match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/i);
    test.skip(!m, "broker shares not enabled in this deployment");
    const uuid = m![1];

    // Embed it, then assert the iframe renders AND serves the published content.
    await chat.sendTurn(embedCmd(uuid), 90_000);
    const frame = page.locator('[data-testid="share-embed"] iframe');
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await expect(frame).toHaveAttribute("src", new RegExp(`/s/${uuid}/$`));
    await expect(frame.contentFrame().locator("#embed-marker")).toContainText(/published share/i, {
      timeout: 90_000,
    });
  });
});
