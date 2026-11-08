/**
 * The k8s contrib's writes and exec run as an impersonated user, on a real cluster. The
 * e2e render's broker holds only `view`, and `scooter-k8s` holds `edit` in agent-sandbox
 * (.github/deployment/test-platform.nix). So an approved write that lands, or an exec that
 * answers, proves it ran as `scooter-k8s`. The rollout hook makes the tool calls from the
 * conversation's own sandbox, with its own token, and reads the cluster back.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

const HOOK = process.env.E2E_ROLLOUT_HOOK ?? "";

/** The file the exec writes, which GET /k8s/mark/<thread> reads back. */
const MARK = "/tmp/k8s-e2e-mark";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
};

type ToolAnswer = { error: boolean; text: string };

/** Call a k8s_* tool from the conversation's sandbox, as its agent would. */
async function tool(request: APIRequestContext, thread: string, name: string, args: object): Promise<ToolAnswer> {
  const res = await request.post(`${HOOK}/k8s/${thread}`, { data: { tool: name, arguments: args }, timeout: 180_000 });
  expect(res.ok(), `the hook must reach the broker: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as ToolAnswer;
}

/** Approve the card the call raised, through the panel. */
async function approve(page: Page) {
  await expect(page.locator(panel.root)).toBeVisible({ timeout: 60_000 });
  await page.locator(panel.option).filter({ hasText: /^\s*approve/i }).first().click();
  await expect(page.locator(panel.root)).toBeHidden({ timeout: 60_000 });
}

/** A conversation with a running sandbox; its thread id. */
async function liveThread(chat: { open(): Promise<void>; completeTurn(t: string, ms?: number): Promise<void> }, page: Page) {
  await chat.open();
  await chat.completeTurn("bring the sandbox up", 100_000);
  const thread = new URL(page.url()).searchParams.get("thread");
  expect(thread, "the URL must name a conversation").toBeTruthy();
  return thread!;
}

fullOnly("needs a real API server enforcing RBAC and impersonation")(
  "k8s writes run as the impersonated user",
  () => {
    // A write needs an owner to approve it; the stack is anonymous unless the ingress names one.
    test.use({ extraHTTPHeaders: { "x-auth-user": "k8s-e2e-owner" } });

    test.beforeEach(() => {
      test.setTimeout(300_000);
      test.skip(!HOOK, "no rollout hook configured for this run");
    });

    test("an approved apply lands though the broker itself cannot patch", async ({ chat, page, request }) => {
      const name = `k8s-e2e-${Date.now()}`;
      const can = await request.get(`${HOOK}/k8s/broker-can/patch/configmaps`);
      expect(await can.text(), "the broker must stay on view").toBe("no");

      const thread = await liveThread(chat, page);
      try {
        const asked = await tool(request, thread, "k8s_apply", {
          manifests: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  who: scooter-k8s\n`,
        });
        // The plan-time dry run is already a write, so it passing is the first proof.
        expect(asked.error, asked.text).toBe(false);
        expect(asked.text).toContain("pending_approval");

        await approve(page);
        await expect
          .poll(async () => (await request.get(`${HOOK}/k8s/configmap/${name}`)).status(), { timeout: 60_000 })
          .toBe(200);
        const data = await (await request.get(`${HOOK}/k8s/configmap/${name}`)).json();
        expect(data).toEqual({ who: "scooter-k8s" });
      } finally {
        await request.delete(`${HOOK}/k8s/configmap/${name}`);
      }
    });

    test("an approved exec answers through the impersonated websocket", async ({ chat, page, request }) => {
      const thread = await liveThread(chat, page);
      const pod = await (await request.get(`${HOOK}/k8s/pod/${thread}`)).text();
      const token = `exec${Date.now()}`;

      const asked = await tool(request, thread, "k8s_exec", {
        pod, container: "sandbox", command: ["sh", "-c", `echo ${token} > ${MARK}`],
      });
      expect(asked.error, asked.text).toBe(false);
      expect(asked.text).toContain("pending_approval");
      await approve(page);
      await expect
        .poll(async () => (await request.get(`${HOOK}/k8s/mark/${thread}`)).text(), { timeout: 60_000 })
        .toBe(token);
    });

    test("a write where scooter-k8s has no role is refused before any card", async ({ chat, page, request }) => {
      const thread = await liveThread(chat, page);
      const asked = await tool(request, thread, "k8s_apply", {
        manifests: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: k8s-e2e-denied\n  namespace: default\ndata: {}\n",
      });
      expect(asked.error, asked.text).toBe(true);
      expect(asked.text).toMatch(/scooter-k8s/);
      await expect(page.locator(panel.root)).toHaveCount(0);
    });
  },
);
