/**
 * THE INVARIANT NOTHING ELSE PINS: the conversation the CLIENT thinks it is in must be
 * the conversation the SERVER actually has.
 *
 * Every other suite asserts INTERNAL consistency — UI surfaces agreeing with each other,
 * or a second tab agreeing with the first. All of those pass when client and server
 * disagree, because a phantom id is copied around consistently:
 *
 *   - concurrency-divergence copies page.url() into tab B — a phantom copies fine
 *   - suspended-recovery deep-links an id it was GIVEN, never one the app wrote
 *   - ui-state-consistency asserts surfaces agree with each other — uniformly wrong passes
 *
 * So a client-minted id reaching the URL was invisible to the whole suite. It shipped
 * three times (#341, #347, and again after) and was found each time by a user, not CI.
 * Observed live: the URL carried an id the server 404s while the stream ran against a
 * different, real one; on refresh the conversation "vanished".
 *
 * These tests cross the boundary: they read what the CLIENT wrote and ask the SERVER
 * about it. The list API is already in every fixture (cleanState uses it), so this was
 * always cheap to write.
 */
import { test, expect } from "./fixtures.js";

/** The `?thread=` id the app itself put in the address bar. */
function threadIdFromUrl(url: string): string | null {
  return new URL(url).searchParams.get("thread");
}

/**
 * Every conversation id the SERVER admits to, asked THROUGH THE BROWSER'S OWN ORIGIN.
 *
 * Deliberately not AGENT_HOST_URL: on a cluster the API is served by the UI's nginx
 * (one origin for app + /conversations), so a direct-to-agent-host URL is both wrong
 * there AND a weaker assertion — it could pass while the path the browser actually
 * uses is broken.
 */
async function serverIds(
  request: { get: (u: string) => Promise<{ json: () => Promise<unknown> }> },
  base: string,
) {
  const list = (await (await request.get(`${base.replace(/\/$/, "")}/conversations`)).json()) as Array<{
    id: string;
  }>;
  return list.map((c) => c.id);
}

/**
 * Assert the server admits to `id` — RE-READING the list before concluding it does not.
 *
 * The invariant is unchanged and just as strict: a client-minted phantom id is never in
 * the list, so it still fails, and it fails on every one of these reads. What the retry
 * removes is a FALSE positive from the read itself. On the full target the list is served
 * by the router's aggregation over the ready pods, which degrades to a PARTIAL list when
 * one is slow or mid-churn — so a perfectly real conversation can be missing from a single
 * read. Observed on CI: the URL carried ff7ec527… while one read returned only cb762ca5…,
 * and this test reported the app's own freshly-created id as "not real".
 *
 * Failing here must mean "the client invented an id", which is a shipped-three-times bug.
 * It must not also mean "one list read was short", which is normal fleet behaviour.
 */
async function expectServerHas(
  request: { get: (u: string) => Promise<{ json: () => Promise<unknown> }> },
  base: string,
  id: string,
  why: string,
) {
  let ids: string[] = [];
  // Single read on fast (the backend is one wiped in-process stack — a miss is real).
  const attempts = process.env.E2E_TARGET === "full" ? 10 : 1;
  for (let i = 0; i < attempts; i++) {
    ids = await serverIds(request, base);
    if (ids.includes(id)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(ids, why).toContain(id);
}

test.describe("client/server conversation identity", () => {
  // CLUSTER-HONEST BUDGETS. The new-conversation test funds TWO full conversation
  // boots in one test. The three straight CI failures here were NOT this budget in
  // the end — they were the second sandbox being unschedulable (Guaranteed 2cpu per
  // sandbox on a 4-vCPU runner; fixed by testing.nix's small sandboxResources) — but
  // the budgets still must fund two sequential sandbox boots at cluster pace
  // (instrumented runs measured 9-12s of ready-pod wait per boot under CPU
  // pressure). NOTE: completeTurn's own poll defaults to 60s — test.setTimeout
  // alone does NOT extend it, which made the first budget bump here a no-op.
  test.setTimeout(240_000);

  test("the id in the URL is one the SERVER issued", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("identity check");

    const urlId = threadIdFromUrl(page.url());
    expect(urlId, "the app must put a thread id in the URL").toBeTruthy();

    // THE ASSERTION. A client-minted id passes every other test in the suite and fails
    // here — the server simply does not have it.
    await expectServerHas(request, base, urlId!, `URL id ${urlId} must exist server-side`);
  });

  test("the URL id survives a reload — the conversation does not vanish", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("reload check");
    const before = threadIdFromUrl(page.url());

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // The reported symptom: refresh and the conversation is gone. That happens when the
    // URL names something the server 404s, so the reload resolves to nothing.
    expect(threadIdFromUrl(page.url()), "the id must not change across a reload").toBe(before);
    await expectServerHas(request, base, before!, `URL id ${before} must exist server-side`);
    await expect(chat.userMessages().first()).toBeVisible({ timeout: 20_000 });
  });

  test("a NEW conversation gets a server id before it appears in the URL", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("first conversation", 100_000);
    const first = threadIdFromUrl(page.url());

    // The exact flow that broke: click New conversation, then send.
    await page.locator('[data-testid="new-session"]').click();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await chat.completeTurn("second conversation", 100_000);

    const second = threadIdFromUrl(page.url());
    expect(second, "a new conversation must get its own id").not.toBe(first);
    await expectServerHas(request, base, second!, `new-conversation URL id ${second} must be real`);
  });

  test("the streamed conversation is the SAME one the URL names", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    const streamed: string[] = [];
    // Catch the divergence directly: the reported failure had the stream on the REAL id
    // while the URL held a phantom, so both "worked" in isolation.
    page.on("request", (r) => {
      const m = /\/conversations\/([0-9a-f-]{36})\/events\.integrity/.exec(r.url());
      if (m) streamed.push(m[1]!);
    });

    await chat.open();
    await chat.completeTurn("stream identity check");

    const urlId = threadIdFromUrl(page.url());
    expect(streamed.length, "the UI must have opened an integrity stream").toBeGreaterThan(0);
    expect(new Set(streamed), "every stream must target the URL's conversation").toEqual(new Set([urlId]));
    await expectServerHas(request, base, urlId!, `URL id ${urlId} must exist server-side`);
  });
});
