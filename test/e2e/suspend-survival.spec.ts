/**
 * E2E — every ARTIFACT of a conversation survives suspension and recovery, not just
 * the conversation itself.
 *
 * `suspended-recovery.spec.ts` covers recovery BEHAVIOUR (the integrity stream serves
 * a suspended conversation, history renders, a send revives it, the queue drains).
 * This file covers recovery CONTENT: it builds a conversation that is rich first —
 * multiple turns, links from two providers, a user-set title, a star — and then
 * asserts each artifact individually. Do not duplicate the behavioural assertions here.
 *
 * ── THE TRIGGERS ────────────────────────────────────────────────────────────────
 *
 * They are not interchangeable; each exposes a different failure, so a test must use
 * the weakest one that can actually break the artifact it names.
 *
 *   1. POST /conversations/:id/suspend        (both targets)
 *      Drops the bridge and the sandbox pod, leaving LOCAL_STATE_PATH intact
 *      (manager.ts:1200-1226). Proves the in-memory rebuild is faithful. It cannot
 *      expose a durability bug, because nothing durable was removed.
 *
 *   2. wipeLocalState()                       (both targets)
 *      Removes the conversation's directory from LOCAL_STATE_PATH and leaves the
 *      durable mirror alone — the state a replacement pod boots into, without a
 *      rollout's other churn. Any read that answers from the local cache alone fails
 *      here; any read that consults the mirror survives.
 *
 *   3. POST <hook>/move/<id>, POST <hook>/restart   (full only)
 *      Replace the owner pod, or the whole Deployment. These additionally evict the
 *      in-memory conversation entry, which is what forces a read through
 *      `ensureReadable` → `hydrateFromMirror` (see the section-4 header).
 *
 * IDLE_SUSPEND_MS is deliberately not used as a trigger. It is a Deployment-wide
 * setting, so shortening it to fit a test would let the sweep suspend conversations
 * belonging to the other full-target specs mid-turn, several of which idle for 30s+
 * waiting on a cold sandbox boot. POST /suspend invokes the same manager.suspend()
 * the sweep calls (index.ts:1297-1303), with no effect on other conversations.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { test, expect, type Page, type APIRequestContext } from "./fixtures.js";
import { fullOnly, isFull } from "./target.js";

/* ───────────────────────────── helpers ───────────────────────────── */

/** The SERVER's id for the conversation the UI is showing.
 *
 *  Read it from the UI's own localStorage rather than `/conversations[0]`: the list
 *  is newest-first across the WHOLE server, so a conversation left behind by another
 *  spec can sit at index 0 and we would enrich/suspend the wrong one. And read
 *  `serverId`, not `currentId` — `currentId` is the stable LOCAL key, which for a
 *  conversation created on its first send is a placeholder the server never issued.
 *  Polled, because serverId is persisted asynchronously after the create round-trips
 *  (on the full target that also crosses the router to the owning pod). */
async function currentConversationId(page: Page): Promise<string> {
  let id = "";
  for (let i = 0; i < 150; i++) {
    id = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("kubenix-agent.sessions.v1");
        if (!raw) return "";
        const st = JSON.parse(raw) as {
          currentId?: string;
          sessions?: Array<{ id: string; serverId?: string }>;
        };
        return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
      } catch {
        return "";
      }
    });
    if (id) break;
    await page.waitForTimeout(100);
  }
  expect(id, "the UI must have a server-issued conversation id").toBeTruthy();
  return id;
}

/** Suspend for real — the same manager.suspend() the idle sweep calls. */
async function suspend(request: APIRequestContext, base: string, id: string) {
  const res = await request.post(`${base}/conversations/${encodeURIComponent(id)}/suspend`);
  expect(res.ok(), `suspend must succeed (got ${res.status()})`).toBeTruthy();
  // Assert the SERVER agrees it is suspended, rather than trusting the 200. A
  // suspend that silently no-ops would make every survival assertion below
  // vacuous — the conversation would never have gone away to come back from.
  const body = (await res.json()) as { status?: string };
  expect(body.status, "the conversation must actually report suspended").toBe("suspended");
}

/** The links the SERVER holds for this conversation (the API the sidebar reads). */
async function serverLinks(
  request: APIRequestContext,
  base: string,
  id: string,
): Promise<Array<{ source: string; url?: string; title?: string }>> {
  const res = await request.get(`${base}/conversations/${encodeURIComponent(id)}/links`);
  if (!res.ok()) return [];
  return ((await res.json()) as { links?: Array<{ source: string; url?: string; title?: string }> })
    .links ?? [];
}

/** This conversation's row from the conversation LIST — the shape the sidebar renders
 *  (view() + withSources: title, starred, model, and the `sources` badge array). */
async function listRow(
  request: APIRequestContext,
  base: string,
  id: string,
): Promise<
  | {
      id: string;
      title?: string;
      starred?: boolean;
      model?: string;
      status?: string;
      sources?: string[];
      links?: Array<{ url?: string }>;
    }
  | undefined
> {
  const res = await request.get(`${base}/conversations`);
  if (!res.ok()) return undefined;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.find((r) => r.id === id) as never;
}

/** Read the integrity SSE stream's REPLAY (up to `synced`) and return the events with
 *  their rolling checksums.
 *
 *  Read INCREMENTALLY and stop at `synced`: events.integrity is long-lived (it replays,
 *  sends `synced`, then stays open with 25s heartbeats), so awaiting the whole body
 *  would block until the server closes — i.e. never — and time out on a perfectly
 *  healthy 200. */
async function integrityReplay(
  page: Page,
  base: string,
  id: string,
): Promise<{
  status: number;
  frames: Array<{ kind?: string; event?: { type?: string; delta?: string; content?: string }; checksum?: string; prevChecksum?: string }>;
  raw: string;
}> {
  return page.evaluate(
    async ({ url }) => {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) return { status: res.status, frames: [], raw: "" };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        if (acc.includes('"kind":"synced"')) break;
      }
      await reader.cancel().catch(() => {});
      const frames: unknown[] = [];
      for (const line of acc.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        try {
          frames.push(JSON.parse(t.slice(5).trim()));
        } catch {
          /* a heartbeat / partial frame — not an event */
        }
      }
      return { status: res.status, frames: frames as never, raw: acc };
    },
    { url: `${base}/conversations/${encodeURIComponent(id)}/events.integrity` },
  );
}

/** Every user-authored message in the replay, in log order. The transcript's spine:
 *  if a turn is missing or reordered here, the conversation the model (and the user)
 *  sees after recovery is not the one they had.
 *
 *  REASSEMBLY, not a filter. A user turn is THREE events (bridge.ts:1089-1091):
 *    TEXT_MESSAGE_START { messageId, role: "user" }
 *    TEXT_MESSAGE_CONTENT { messageId, delta }      × n
 *    TEXT_MESSAGE_END { messageId }
 *  The role is only on START and the text is only on CONTENT — no single event carries
 *  both — so the deltas must be correlated by messageId and concatenated. (Assistant
 *  text streams token-by-token through the same shape, which is why a naive
 *  "frame contains the text" check is unreliable for either role.)
 *
 *  Ordering is taken from FIRST APPEARANCE of each messageId, so a turn is reported
 *  where it actually began in the log — an interleaved or spliced log therefore shows
 *  up as a wrong order rather than being silently normalised away. */
function userTurns(
  frames: Array<{ event?: { type?: string; role?: string; messageId?: string; delta?: string } }>,
): string[] {
  const userMsgIds: string[] = [];
  const text = new Map<string, string>();
  for (const f of frames) {
    const e = f.event;
    if (!e?.messageId) continue;
    if (e.type === "TEXT_MESSAGE_START" && e.role === "user") {
      if (!text.has(e.messageId)) {
        userMsgIds.push(e.messageId);
        text.set(e.messageId, "");
      }
    } else if (e.type === "TEXT_MESSAGE_CONTENT" && text.has(e.messageId)) {
      text.set(e.messageId, text.get(e.messageId)! + (e.delta ?? ""));
    }
  }
  return userMsgIds.map((id) => (text.get(id) ?? "").trim()).filter((t) => t.length > 0);
}

/** Whether the replay's rolling checksum chain is intact — every frame's prevChecksum
 *  equals the previous frame's checksum. This is the property the UI self-heals on,
 *  and the one a spliced/forked log breaks. Returns the chain's FINAL checksum so a
 *  caller can compare it against the independent /history aggregate. */
function chainIntact(
  frames: Array<{ checksum?: string; prevChecksum?: string }>,
): { ok: boolean; brokeAt: number; last: string | undefined; length: number } {
  const chained = frames.filter((f) => f.checksum !== undefined && f.prevChecksum !== undefined);
  for (let i = 1; i < chained.length; i++) {
    if (chained[i].prevChecksum !== chained[i - 1].checksum) {
      return { ok: false, brokeAt: i, last: undefined, length: chained.length };
    }
  }
  return {
    ok: true,
    brokeAt: -1,
    last: chained.at(-1)?.checksum,
    length: chained.length,
  };
}

/** The conversation's full history plus the AGGREGATE rolling checksum through its last
 *  event (`GET /conversations/:id/history` → `{ events, checksum }`).
 *
 *  A SECOND, INDEPENDENT WITNESS to the log. events.integrity streams the chain
 *  per-event; this route computes it server-side over the whole log. Cross-checking the
 *  two means a survival test cannot be satisfied by one code path that happens to be
 *  self-consistent — the log has to be the same log by two different readings. */
async function history(
  request: APIRequestContext,
  base: string,
  id: string,
): Promise<{ events: Array<{ type?: string }>; checksum?: string }> {
  const res = await request.get(`${base}/conversations/${encodeURIComponent(id)}/history`);
  expect(res.ok(), `GET /history must succeed (got ${res.status()})`).toBeTruthy();
  return (await res.json()) as { events: Array<{ type?: string }>; checksum?: string };
}

/** Disturb the cluster via the CI rollout hook. Returns the response so a test can
 *  assert on it — a hook that 404s/409s must FAIL the test rather than silently
 *  skipping the very event under test. */
async function hook(
  request: APIRequestContext,
  path: string,
): Promise<import("@playwright/test").APIResponse> {
  const base = process.env.E2E_ROLLOUT_HOOK ?? "";
  expect(base, "E2E_ROLLOUT_HOOK must be configured for the full target").toBeTruthy();
  return request.post(`${base}${path}`, { timeout: 200_000 });
}

/**
 * Remove this conversation's directory from LOCAL_STATE_PATH, leaving the durable
 * mirror untouched. Postcondition: the local cache no longer holds the conversation
 * and the mirror still does — so any read that survives is reading durable state.
 *
 * Runs on both targets. The fast stack is configured with the production two-store
 * topology (LOCAL_STATE_PATH + MIRROR_STATE_PATH, playwright.config.ts:113-119), so
 * local-vs-mirror divergence is expressible there and does not need a cluster.
 *
 * Two mechanisms, same postcondition:
 *   fast — `node:fs` rm. Spec files run in Node, so this is direct.
 *   full — the rollout hook execs `rm -rf` in the pod that owns the conversation.
 */
async function wipeLocalState(request: APIRequestContext, id: string): Promise<string> {
  if (isFull) {
    const res = await hook(request, `/wipe-local/${encodeURIComponent(id)}`);
    const detail = await res.text();
    expect(res.ok(), `the hook must wipe the owner pod's local state: ${detail}`).toBeTruthy();
    return detail;
  }
  // The fast stack's agent-host runs with this exact LOCAL_STATE_PATH (playwright.config.ts:113).
  const localRoot = process.env.LOCAL_STATE_PATH ?? "/tmp/agent-host-e2e";
  const mirrorRoot = process.env.MIRROR_STATE_PATH ?? "/tmp/agent-host-e2e-mirror";
  const dir = join(localRoot, id);
  const held = existsSync(dir) ? readdirSync(dir).join(",") : "(nothing)";
  rmSync(dir, { recursive: true, force: true });
  // PRECONDITION FOR THE WHOLE TEST, not a nicety. If the mirror does not actually
  // hold this conversation, then "the data is durable and the read path loses it" is
  // not the situation under test — the data would be genuinely gone, and a red result
  // would prove nothing about the read path. Assert the mirror still has it.
  expect(
    existsSync(join(mirrorRoot, id)),
    "the DURABLE mirror must still hold this conversation — otherwise the wipe destroyed " +
      "the data rather than just the cache, and the survival assertion would be vacuous",
  ).toBe(true);
  return `wiped ${dir} (held: ${held}); mirror intact`;
}

/* ─────────────────────── the rich-conversation builder ─────────────────────── */

const LINKS = [
  {
    source: "github",
    resourceType: "pull_request",
    url: "https://github.com/example-org/example-app/pull/9001",
    title: "example-org/example-app #9001",
  },
  {
    source: "slack",
    resourceType: "thread",
    url: "https://example.slack.com/archives/C123/p1700000000000000",
    title: "#eng-scooter thread",
  },
];

interface RichConversation {
  id: string;
  /** The user turns sent, in order — the expected transcript spine. */
  turns: string[];
  title: string;
}

/**
 * Build a conversation that actually HAS something to lose: several turns, two links
 * from different providers, a user-set title, and a star.
 *
 * A recovery test is only as strong as the state it puts at risk: an empty
 * conversation survives trivially. Every test in this file starts here, so recovery
 * has to carry six distinct artifacts across and each can be asserted separately.
 */
async function buildRichConversation(
  chat: import("./fixtures.js").Chat,
  page: Page,
  request: APIRequestContext,
  base: string,
  turns: string[],
  title: string,
): Promise<RichConversation> {
  await chat.open();
  // completeTurn (not send+waitForReply): it waits for the assistant-message COUNT to
  // grow AND for the run to reach idle, so the next send cannot race an unfinished run
  // and get dropped. waitForReply matches the FIRST occurrence of its regex, which a
  // prior identical fake-agent reply already satisfies — it would return instantly and
  // silently lose turns from the transcript this file is about to assert on.
  for (const t of turns) await chat.completeTurn(t, 120_000);

  const id = await currentConversationId(page);

  for (const link of LINKS) {
    const r = await request.post(`${base}/conversations/${encodeURIComponent(id)}/links`, {
      data: link,
    });
    expect(r.ok(), `seeding the ${link.source} link must succeed (${r.status()})`).toBeTruthy();
  }
  const titled = await request.patch(`${base}/conversations/${encodeURIComponent(id)}/title`, {
    data: { title },
  });
  expect(titled.ok(), `setting the title must succeed (${titled.status()})`).toBeTruthy();
  const starRes = await request.patch(`${base}/conversations/${encodeURIComponent(id)}/starred`, {
    data: { starred: true },
  });
  expect(starRes.ok(), `starring must succeed (${starRes.status()})`).toBeTruthy();
  // Register for afterEach cleanup BEFORE any assertion below can throw.
  starred.push(id);

  // PRECONDITION, not decoration. Every assertion after recovery is meaningless if the
  // artifact was never there to begin with — a seed that silently failed would make the
  // whole test a tautology. Prove the rich state EXISTS before disturbing anything.
  const before = await serverLinks(request, base, id);
  expect(before.map((l) => l.url).sort(), "both links must exist BEFORE recovery").toEqual(
    LINKS.map((l) => l.url).sort(),
  );
  const row = await listRow(request, base, id);
  expect(row?.title, "the title must be set BEFORE recovery").toBe(title);
  expect(row?.starred, "the star must be set BEFORE recovery").toBe(true);

  return { id, turns, title };
}

/** Conversations this test starred, to be unstarred in afterEach.
 *
 *  A starred conversation returns 409 on DELETE, so `cleanState` cannot remove it: it
 *  exhausts every attempt and hands the leftover to every later spec on the shard.
 *  Starring is one of the artifacts under test here, so the star MUST be handed back
 *  even when the test fails — and several tests in this file are expected to fail
 *  while the read paths they cover are unfixed. Cleanup therefore cannot live at the
 *  end of a test body, which an earlier assertion failure skips. */
const starred: string[] = [];

test.afterEach(async ({ request, baseURL }) => {
  const base = (baseURL ?? "").replace(/\/$/, "");
  const ids = starred.splice(0);
  for (const id of ids) {
    // Best-effort per id, and never let one failure skip the rest: an unreachable
    // conversation must not strand the stars of the others.
    await request
      .patch(`${base}/conversations/${encodeURIComponent(id)}/starred`, { data: { starred: false } })
      .catch(() => undefined);
  }
});

/* ─────────────────────────────── budgets ─────────────────────────────── */

// CLUSTER-HONEST BUDGETS (the pattern: stop-run.spec.ts:75 — measured arithmetic, not
// a round number). A sandbox boot on the full target is 5-25s cold.
//
// SUSPEND_BUDGET — the two-boot shape, plus a richer opening than the existing specs:
//   3 turns × (boot ≤25s first, then ~10s each) ≈ 45s
// + link/title/star seeding + the precondition reads      ≈  5s
// + suspend + a revive turn that provisions a FRESH pod    ≈ 35s
// + the post-recovery API + UI assertions                  ≈ 15s
//   ────────────────────────────────────────────────────── ≈ 100s expected, 240s ceiling.
const SUSPEND_BUDGET = 240_000;

// WIPE_BUDGET — as above, plus the hook's kubectl exec into the owner pod (a few
// seconds) and a revive. No pod is replaced, so there is no rollout wait.  300s.
const WIPE_BUDGET = 300_000;

// ROLLOUT_BUDGET — the whole fleet is replaced: `rollout status` alone is allowed 180s
// by the hook, then the conversation must be reassigned, hydrated from the mirror and
// revived, and a turn must run on a brand-new sandbox. 180 + ~60 + ~40 ≈ 280s expected.
// 540s ceiling.
const ROLLOUT_BUDGET = 540_000;

/* ══════════════════════════════════════════════════════════════════════════════
   1. THE TRANSCRIPT — the artifact everything else is anchored to.
   ══════════════════════════════════════════════════════════════════════════════ */

test.describe("survival: the conversation transcript", () => {
  test.setTimeout(SUSPEND_BUDGET);

  test("every turn survives a suspend, IN ORDER and with an intact integrity chain", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Asserted off the INTEGRITY STREAM, not off rendered message counts. A count is
    // satisfied by any N messages — it cannot tell "all three turns, in order" from
    // "one turn rendered three times", and it says nothing about the checksum chain
    // the UI self-heals on. The chain is the property that makes the log trustworthy,
    // so it is the property to assert.
    const base = (baseURL ?? "").replace(/\/$/, "");
    const turns = ["turn one: the premise", "turn two: the complication", "turn three: the ask"];
    const conv = await buildRichConversation(chat, page, request, base, turns, "transcript survival");

    const before = await integrityReplay(page, base, conv.id);
    expect(before.status, "the integrity stream must serve the live conversation").toBe(200);
    const beforeTurns = userTurns(before.frames);
    // The precondition: the log really does hold all three, in order. If the fake agent
    // or the composer dropped one, the post-suspend comparison would "pass" against a
    // short baseline — the tautology this guards against.
    expect(beforeTurns, "all three turns must be in the log BEFORE the suspend").toEqual(turns);
    const beforeHistory = await history(request, base, conv.id);
    const beforeChain = chainIntact(before.frames);
    expect(beforeChain.ok, "the chain must be intact before the suspend").toBe(true);

    await suspend(request, base, conv.id);

    const after = await integrityReplay(page, base, conv.id);
    expect(after.status, "a suspended conversation's log must still be readable").toBe(200);
    expect(
      userTurns(after.frames),
      "every turn must survive the suspend, in the same order",
    ).toEqual(turns);

    const chain = chainIntact(after.frames);
    expect(
      chain.ok,
      `the integrity chain must be unbroken after recovery (broke at frame ${chain.brokeAt})`,
    ).toBe(true);

    // THE STRONGEST FORM OF "nothing changed": the rolling checksum is a hash chain over
    // every event in order, so an identical final checksum means the log is byte-identical
    // end to end. Any lost, added, reordered or mutated event changes it. Asserting this
    // is what makes the test resistant to a recovery that reconstructs a plausible-looking
    // but different transcript — which counting messages would happily accept.
    expect(
      chain.last,
      "the log's final checksum must be UNCHANGED by a suspend — a different value means " +
        "an event was lost, added, reordered or altered",
    ).toBe(beforeChain.last);

    // Cross-check against the independent /history aggregate, so the assertion does not
    // rest on the integrity stream alone agreeing with itself.
    const afterHistory = await history(request, base, conv.id);
    expect(afterHistory.checksum, "the /history aggregate checksum must also be unchanged").toBe(
      beforeHistory.checksum,
    );
    expect(
      afterHistory.checksum,
      "the two independent checksum surfaces must agree with each other",
    ).toBe(chain.last);
    expect(
      afterHistory.events.length,
      "the event COUNT must be unchanged too",
    ).toBe(beforeHistory.events.length);

  });

  test("the recovered transcript renders in the UI, not just in the API", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The API half above can pass while the user still sees an empty thread — the log
    // is intact but the client never paints it. So assert the SAME turns through the
    // rendered DOM. Neither assertion alone is sufficient: an API-only test misses what
    // the user looks at, and a UI-only test can pass on a cached render.
    const base = (baseURL ?? "").replace(/\/$/, "");
    const turns = ["rendered turn one", "rendered turn two"];
    const conv = await buildRichConversation(chat, page, request, base, turns, "render survival");

    await suspend(request, base, conv.id);

    // Deep-link rather than reload: the sidebar is shared across specs, so a STARRED
    // leftover can win the restored selection and leave us asserting against a
    // different (empty) thread.
    await page.goto(`/?thread=${encodeURIComponent(conv.id)}`);
    await expect(chat.input()).toBeVisible({ timeout: 30_000 });
    for (const t of turns) {
      await expect(
        chat.userMessages().filter({ hasText: t }),
        `"${t}" must render after the suspend`,
      ).toHaveCount(1, { timeout: 40_000 });
    }

  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   2. META — title, star, model. Carried on meta.json, which hydrateFromMirror
      DOES rescue, so these are expected to survive even the wipe.
   ══════════════════════════════════════════════════════════════════════════════ */

test.describe("survival: conversation metadata", () => {
  test.setTimeout(SUSPEND_BUDGET);

  test("title, star and model survive a suspend — in the API and in the sidebar", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // NOTE ON STRENGTH: a plain suspend does not clear the local state dir, so this
    // proves the in-memory rebuild is faithful — NOT that the data is durable. The
    // durability question is the wipe test below, which covers meta as well.
    const base = (baseURL ?? "").replace(/\/$/, "");
    const conv = await buildRichConversation(
      chat,
      page,
      request,
      base,
      ["meta survival opening turn"],
      "a deliberately distinctive title",
    );
    const modelBefore = (await listRow(request, base, conv.id))?.model;

    await suspend(request, base, conv.id);

    const row = await listRow(request, base, conv.id);
    expect(row, "the conversation must still be listed after a suspend").toBeTruthy();
    expect(row?.title, "the user-set title must survive").toBe(conv.title);
    expect(row?.starred, "the star must survive").toBe(true);
    expect(row?.model, "the model selection must survive").toBe(modelBefore);

    // And through the UI — the sidebar row is what the user actually reads.
    await page.goto(`/?thread=${encodeURIComponent(conv.id)}`);
    await expect(chat.input()).toBeVisible({ timeout: 30_000 });
    const sidebarRow = page.locator(`[data-testid="session-item"][data-conversation-id="${conv.id}"]`);
    await expect(sidebarRow, "the conversation's sidebar row must exist").toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(sidebarRow, "the sidebar must show the surviving title").toContainText(
      conv.title,
      { timeout: 30_000 },
    );

  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   3. LINKS.
   ══════════════════════════════════════════════════════════════════════════════ */

test.describe("survival: linked resources", () => {
  test.setTimeout(SUSPEND_BUDGET);

  test("links survive a plain suspend (same pod, local store intact)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // SCOPE: suspend leaves LOCAL_STATE_PATH in place, so this proves the links are
    // re-read correctly after the bridge and pod are dropped. It does NOT prove they
    // are durable — that is the wipe test below. Read together, the pair localises any
    // failure to one trigger or the other.
    const base = (baseURL ?? "").replace(/\/$/, "");
    const conv = await buildRichConversation(
      chat,
      page,
      request,
      base,
      ["links across a suspend"],
      "links: plain suspend",
    );

    await suspend(request, base, conv.id);

    const links = await serverLinks(request, base, conv.id);
    expect(
      links.map((l) => l.url).sort(),
      "both links must survive a suspend that leaves the local store in place",
    ).toEqual(LINKS.map((l) => l.url).sort());

  });

  test("the link BADGE is still on the sidebar row after a suspend", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The badge is driven by `sources` on the /conversations row (withSources →
    // store.listLinks), so it can vanish while the conversation itself is healthy.
    // Assert what is rendered, not only what the API returns.
    const base = (baseURL ?? "").replace(/\/$/, "");
    const conv = await buildRichConversation(
      chat,
      page,
      request,
      base,
      ["badge across a suspend"],
      "links: badge",
    );

    await suspend(request, base, conv.id);

    await page.goto(`/?thread=${encodeURIComponent(conv.id)}`);
    await expect(chat.input()).toBeVisible({ timeout: 30_000 });

    const row = page.locator(`[data-testid="session-item"][data-conversation-id="${conv.id}"]`);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(
      row.locator('[data-testid="source-icon"][data-source="github"]'),
      "the github badge must survive the suspend",
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      row.locator('[data-testid="source-icon"][data-source="slack"]'),
      "the slack badge must survive too",
    ).toHaveCount(1, { timeout: 30_000 });

    // And the panel the user opens to click through to the PR.
    await expect(page.locator('[data-testid="linked-resources"]')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="linked-resource"]').filter({ hasText: /#9001/ }),
      "the PR link must still be clickable in the panel",
    ).toHaveCount(1, { timeout: 30_000 });

  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   4. THE LOCAL-CACHE WIPE.

   A conversation's durable state is written to both the local cache and the mirror.
   These tests remove the local copy and require the read paths to answer from the
   mirror. An artifact that cannot is lost whenever a pod is replaced.

   ── WHICH TARGET EACH BLOCK NEEDS ───────────────────────────────────────────────

   Replacing a pod does two separable things: it wipes the local cache, AND it evicts
   the in-memory conversation entry. wipeLocalState() reproduces the first on either
   target; only a real pod replacement reproduces the second, because a single
   long-lived agent-host keeps the entry in its map and there is no eviction primitive
   short of `end()`, which destroys the conversation outright.

   That decides the split:

     - `GET /conversations/:id/links` reads `store.listLinks` directly
       (management.ts:844-848) — it never calls `ensureReadable`, so no hydrate can
       run whether or not the entry is cached. The wipe alone is sufficient, and these
       tests run on BOTH targets.

     - Event and meta reads go through `ensureReadable`, which returns early while the
       entry is in memory (manager.ts:1104-1106) and so never reaches
       `hydrateFromMirror`. Wiping without evicting points them at a deleted file with
       no rescue path available — a condition a real rollout never produces. Those
       tests are therefore `fullOnly`, where the eviction is real.
   ══════════════════════════════════════════════════════════════════════════════ */

test.describe("survival: linked resources across the rollout WIPE of the local state dir", () => {
    test.setTimeout(WIPE_BUDGET);

    test("LINKS survive the emptyDir wipe (they are in the mirror; the read must find them)", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      // addLink writes to BOTH stores (mirroredStore.ts:213-215), so a link is durable
      // the moment it is created. listLinks reads local only (:164), so wiping the local
      // copy must not be able to hide it. Satisfied when the read consults the durable
      // store, whether that store is the mirror or Postgres.
      const base = (baseURL ?? "").replace(/\/$/, "");
      const conv = await buildRichConversation(
        chat,
        page,
        request,
        base,
        ["links across the wipe"],
        "links: emptyDir wipe",
      );

      await wipeLocalState(request, conv.id);

      // Suspend so the conversation is rebuilt the way a replacement pod rebuilds it
      // (drop the bridge, then hydrate from the mirror on the next read), rather than
      // being answered out of an in-memory entry that predates the wipe.
      //
      // Deliberately NOT calling POST /resume: unlike suspend/DELETE/GET it has no
      // hydrate-if-absent (management.ts:550-554), so on a multi-replica fleet it 404s
      // from any pod that does not already hold the conversation — which would make
      // this step a silent no-op exactly when it matters most. The reads below all go
      // through routes that DO hydrate, which is the same path the real UI takes.
      await suspend(request, base, conv.id);

      const links = await serverLinks(request, base, conv.id);
      expect(
        links.map((l) => l.url).sort(),
        "links are written to the durable mirror, so a wiped local cache must NOT lose them",
      ).toEqual(LINKS.map((l) => l.url).sort());

    });

    test("the link BADGE returns after the emptyDir wipe", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      // The rendered half of the same guarantee: the API returning the links is not
      // sufficient if the badge does not paint from them.
      const base = (baseURL ?? "").replace(/\/$/, "");
      const conv = await buildRichConversation(
        chat,
        page,
        request,
        base,
        ["badge across the wipe"],
        "links: badge after wipe",
      );

      await wipeLocalState(request, conv.id);
      await suspend(request, base, conv.id);

      await page.goto(`/?thread=${encodeURIComponent(conv.id)}`);
      await expect(chat.input()).toBeVisible({ timeout: 40_000 });
      const row = page.locator(`[data-testid="session-item"][data-conversation-id="${conv.id}"]`);
      await expect(row, "the conversation must still be listed (it IS in the mirror)").toHaveCount(
        1,
        { timeout: 40_000 },
      );
      await expect(
        row.locator('[data-testid="source-icon"][data-source="github"]'),
        "the github badge must come back from the durable store after the local wipe",
      ).toHaveCount(1, { timeout: 40_000 });

    });
});

/* ── THE CONTROLS. Full target only, for the reason in the section header: they need
      the pod (and its in-memory entry) to actually be replaced, which is the half of a
      rollout the fast stack cannot simulate. Without them a red links test is just an
      assertion that failed; with them it is an ISOLATED failure — same wipe, same
      conversation, events and meta come back and links do not. ────────────────────── */

fullOnly("needs a real pod replacement so the in-memory entry is evicted and hydrateFromMirror runs")(
  "survival: the wipe CONTROLS — what the mirror does rescue",
  () => {
    test.setTimeout(WIPE_BUDGET);

    test("the TRANSCRIPT survives the emptyDir wipe (hydrateFromMirror rescues events)", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      // The control for the link tests: events ARE copied back by hydrateFromMirror
      // (mirroredStore.ts:241-275), so this must pass under the same wipe that the link
      // reads fail. A failure here would mean the wipe damages more than the read path,
      // and no other result in this file could be attributed to a specific artifact.
      //
      // The pod move evicts the in-memory entry, so the next read's ensureReadable
      // reaches hydrateFromMirror instead of short-circuiting (manager.ts:1104-1106).
      const base = (baseURL ?? "").replace(/\/$/, "");
      const turns = ["wiped turn one", "wiped turn two"];
      const conv = await buildRichConversation(
        chat,
        page,
        request,
        base,
        turns,
        "transcript: emptyDir wipe",
      );

      await wipeLocalState(request, conv.id);
      // Replace the pod so the in-memory entry goes with it — see the block comment.
      const moved = await hook(request, `/move/${encodeURIComponent(conv.id)}`);
      expect(moved.ok(), `the owner pod must be deleted: ${await moved.text()}`).toBeTruthy();

      // The reassign + hydrate is asynchronous, so poll rather than reading once: a
      // single read here would race the controller and report an empty log that is
      // simply not hydrated YET — a false red on the very control that has to be
      // trustworthy.
      await expect
        .poll(
          async () => {
            const r = await integrityReplay(page, base, conv.id);
            return r.status === 200 ? userTurns(r.frames).join("|") : "";
          },
          { timeout: 150_000, intervals: [3_000] },
        )
        .toBe(turns.join("|"));

    });

    test("TITLE and STAR survive the emptyDir wipe (meta is hydrated from the mirror)", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      // The second control. hydrateFromMirror pulls meta first (mirroredStore.ts:227-230)
      // and listConversations unions the durable store (:174-189), so title and star must
      // survive the same wipe that the link reads fail — which is what narrows the failure
      // to the read delegations that were never migrated.
      const base = (baseURL ?? "").replace(/\/$/, "");
      const conv = await buildRichConversation(
        chat,
        page,
        request,
        base,
        ["meta across the wipe"],
        "meta: emptyDir wipe",
      );

      await wipeLocalState(request, conv.id);
      const moved = await hook(request, `/move/${encodeURIComponent(conv.id)}`);
      expect(moved.ok(), `the owner pod must be deleted: ${await moved.text()}`).toBeTruthy();

      // Poll: the row reappears once the conversation is reassigned and some pod has
      // hydrated it. Reading once would race the controller (see the transcript control).
      await expect
        .poll(async () => (await listRow(request, base, conv.id))?.title, {
          timeout: 150_000,
          intervals: [3_000],
        })
        .toBe(conv.title);
      const row = await listRow(request, base, conv.id);
      expect(row?.starred, "the star must come back from the mirror").toBe(true);

    });
  },
);

/* ══════════════════════════════════════════════════════════════════════════════
   5. THE REAL ROLLOUT — every pod replaced, end to end. Full target only.
   ══════════════════════════════════════════════════════════════════════════════ */

fullOnly("needs a real rollout-restart of the agent-host Deployment")(
  "survival: across a real agent-host rollout",
  () => {
    test.setTimeout(ROLLOUT_BUDGET);

    test("a RICH conversation comes through a rollout with everything intact", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      // Every artifact is asserted in ONE test rather than one rollout per artifact: a
      // rollout costs ~3 minutes and the artifacts share the same wiped cache, so
      // separate rollouts would multiply the runtime without isolating anything further.
      // The links check runs LAST so that a links failure still reports which of the
      // other artifacts survived.
      const base = (baseURL ?? "").replace(/\/$/, "");
      const turns = ["before the rollout: one", "before the rollout: two"];
      const conv = await buildRichConversation(
        chat,
        page,
        request,
        base,
        turns,
        "rich conversation across a rollout",
      );

      const restarted = await hook(request, "/restart");
      expect(restarted.ok(), `the rollout must complete: ${await restarted.text()}`).toBeTruthy();

      // 1. It still EXISTS and is still readable.
      await expect
        .poll(async () => (await listRow(request, base, conv.id)) !== undefined, {
          timeout: 120_000,
          intervals: [2_000],
        })
        .toBe(true);

      // 2. The transcript, in order, off the durable log.
      const after = await integrityReplay(page, base, conv.id);
      expect(after.status, "the log must be served by whichever pod now owns it").toBe(200);
      expect(userTurns(after.frames), "every turn must survive the rollout").toEqual(turns);

      // 3. Meta.
      const row = await listRow(request, base, conv.id);
      expect(row?.title, "the title must survive the rollout").toBe(conv.title);
      expect(row?.starred, "the star must survive the rollout").toBe(true);

      // 4. It is still USABLE — not merely readable. A conversation that survives as a
      //    read-only artifact has still failed the user.
      await page.goto(`/?thread=${encodeURIComponent(conv.id)}`);
      await expect(chat.input()).toBeVisible({ timeout: 60_000 });
      await chat.completeTurn("after the rollout", 150_000);

      // 5. LINKS — asserted last, for the reason in the header comment.
      const links = await serverLinks(request, base, conv.id);
      expect(
        links.map((l) => l.url).sort(),
        "the links were written to the durable mirror — a rollout must not lose them",
      ).toEqual(LINKS.map((l) => l.url).sort());

    });
  },
);
