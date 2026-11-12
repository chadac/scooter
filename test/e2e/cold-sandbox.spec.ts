/**
 * A conversation never waits on its sandbox pod: a message lands at once, and only the
 * reply waits for the pod. The fast stack holds a cold-pod-* owner's fake sandbox for
 * FAKE_SANDBOX_COLD_MS (8s); the full target uses real cold pods, checked via the hook.
 */
import type { APIRequestContext, Browser, Page } from "@playwright/test";

import { Chat, expect, test } from "./fixtures.js";
import { fastOnly, fullOnly } from "./target.js";

const HOOK = process.env.E2E_ROLLOUT_HOOK ?? "";
/** A real pod's boot, from Sandbox create to the agent answering. */
const BOOT_MS = 300_000;

/** Matches FAKE_SANDBOX_COLD_MS in support/fakeBackend.mjs. */
const COLD_MS = 8_000;
/** Well inside the hold, so passing it means nothing waited for the pod. */
const PROMPT_MS = 3_000;

async function coldPodUser(browser: Browser): Promise<Page> {
  const user = `cold-pod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-auth-user": user } });
  return context.newPage();
}

/** Creates a conversation, failing if the request waited for the pod; the first prompt provisions it. */
async function createCold(page: Page): Promise<string> {
  const t0 = Date.now();
  const res = await page.request.post("/conversations", { data: {} });
  expect(res.ok(), `create: ${res.status()}`).toBeTruthy();
  expect(Date.now() - t0, "POST /conversations waited for the sandbox").toBeLessThan(PROMPT_MS);
  return ((await res.json()) as { id: string }).id;
}

fastOnly("the cold-pod hold is a fake-sandbox knob")("cold sandbox pod", () => {
  test.beforeEach(() => test.setTimeout(90_000));

  test("OUTCOME: the first message posts at once and is answered once the pod is up", async ({ browser }) => {
    const page = await coldPodUser(browser);
    try {
      const chat = new Chat(page);
      const id = await createCold(page);
      const created = Date.now();
      await page.goto(`/?thread=${id}`);
      await expect(chat.input()).toBeVisible({ timeout: 20_000 });

      const token = `COLD-${Date.now()}`;
      await chat.send(token);
      await expect(chat.userMessages().filter({ hasText: token })).toHaveCount(1, { timeout: PROMPT_MS });

      // The reply needs the pod, so it cannot beat the hold; seeing it early means no hold ran.
      const reply = chat.assistantMessages().filter({ hasText: token });
      await expect(reply.first()).toBeVisible({ timeout: COLD_MS + 30_000 });
      expect(Date.now() - created, "the reply arrived before the pod came up").toBeGreaterThanOrEqual(COLD_MS - 500);
    } finally {
      await page.context().close();
    }
  });

  test("OUTCOME: a message with a file attached posts without waiting for the pod", async ({ browser }) => {
    const page = await coldPodUser(browser);
    try {
      const chat = new Chat(page);
      const id = await createCold(page);
      await page.goto(`/?thread=${id}`);
      await expect(chat.input()).toBeVisible({ timeout: 20_000 });

      const chooser = page.waitForEvent("filechooser");
      await page.getByLabel("Add Attachment").click();
      await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("cold pod upload\n") });

      const token = `COLD-FILE-${Date.now()}`;
      const input = page.getByRole("textbox", { name: "Message input" });
      await input.click();
      await input.fill(token);
      await page.getByRole("button", { name: /send message/i }).click();
      await expect(chat.userMessages().filter({ hasText: token })).toHaveCount(1, { timeout: PROMPT_MS });

      // The fake agent echoes the upload note, so the reply names the written file.
      await expect(chat.assistantMessages().filter({ hasText: "/workspace/uploads/notes.txt" }).first()).toBeVisible({
        timeout: COLD_MS + 30_000,
      });
    } finally {
      await page.context().close();
    }
  });
});

/** The sandbox pod's Ready status: "True", "False" or "absent". */
async function podReady(request: APIRequestContext, thread: string): Promise<string> {
  const res = await request.get(`${HOOK}/pod-ready/${thread}`);
  expect(res.ok(), `pod-ready: ${res.status()}`).toBeTruthy();
  return (await res.text()).trim();
}

/** Sends `text` and asserts it lands in the transcript before the pod is Ready. */
async function sendWhileCold(chat: Chat, request: APIRequestContext, thread: string, text: string) {
  await chat.send(text);
  await expect(chat.userMessages().filter({ hasText: text })).toHaveCount(1, { timeout: PROMPT_MS });
  expect(await podReady(request, thread), "the pod was already Ready, so nothing was cold").not.toBe("True");
}

fullOnly("needs real sandbox pods and the rollout hook")("cold sandbox pod (cluster)", () => {
  test.beforeEach(() => {
    test.skip(!HOOK, "no rollout hook configured for this run");
    test.setTimeout(BOOT_MS * 2 + 120_000);
  });

  test("OUTCOME: a new conversation's first message lands before its pod is Ready", async ({ chat, page, request }) => {
    const id = await createCold(page);
    await page.goto(`/?thread=${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    const token = `COLD-K8S-${Date.now()}`;
    await sendWhileCold(chat, request, id, token);
    await expect(chat.assistantMessages().filter({ hasText: token }).first()).toBeVisible({ timeout: BOOT_MS });
  });

  test("OUTCOME: a message to a suspended conversation lands before its pod is back", async ({ chat, page, request }) => {
    const id = await createCold(page);
    await page.goto(`/?thread=${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    const first = `WARM-${Date.now()}`;
    await chat.send(first);
    await expect(chat.assistantMessages().filter({ hasText: first }).first()).toBeVisible({ timeout: BOOT_MS });
    // Suspending mid-run leaves a dangling run; the next send queues.
    await chat.waitForIdle(60_000);

    const res = await page.request.post(`/conversations/${id}/suspend`);
    expect(res.ok(), `suspend: ${res.status()}`).toBeTruthy();
    await expect.poll(() => podReady(request, id), { message: "suspend must drop the pod", timeout: 120_000 }).toBe("absent");

    const token = `RESUMED-${Date.now()}`;
    await sendWhileCold(chat, request, id, token);
    await expect(chat.assistantMessages().filter({ hasText: token }).first()).toBeVisible({ timeout: BOOT_MS });
  });

  test("OUTCOME: a file sent to a cold pod lands, and is in the pod once it is up", async ({ chat, page, request }) => {
    const id = await createCold(page);
    await page.goto(`/?thread=${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    const chooser = page.waitForEvent("filechooser");
    await page.getByLabel("Add Attachment").click();
    const content = `cold pod upload ${Date.now()}`;
    await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(`${content}\n`) });

    const token = `COLD-K8S-FILE-${Date.now()}`;
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.click();
    await input.fill(token);
    await page.getByRole("button", { name: /send message/i }).click();
    await expect(chat.userMessages().filter({ hasText: token })).toHaveCount(1, { timeout: PROMPT_MS });
    expect(await podReady(request, id), "the pod was already Ready, so nothing was cold").not.toBe("True");

    // The fake agent echoes the upload note, so the reply names the written file.
    await expect(chat.assistantMessages().filter({ hasText: "/workspace/uploads/notes.txt" }).first()).toBeVisible({
      timeout: BOOT_MS,
    });
    await chat.send("!cat /workspace/uploads/notes.txt");
    await expect(chat.assistantMessages().filter({ hasText: content }).first()).toBeVisible({ timeout: 60_000 });
  });
});
