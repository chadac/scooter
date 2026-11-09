/**
 * Tier 3 E2E for contrib views, through kanban's /boards: a board made on /boards shows
 * its conversations as cards in its stages, a move files the conversation in the stage's
 * folder and is told to that conversation, a card opens its chat beside the board, and the
 * user edits the board's stages. The manifest and kanban's broker routes are stubbed, since
 * the fast stack has no broker; the stub makes the board and stage folders through the
 * router as the user, so they aren't locked here. The view is the kanban contrib's real module.
 */

import { type APIRequestContext, type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const STAGES = ["Design", "In progress", "Review", "Done"];

interface Stage {
  id: string;
  label: string;
  position: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  position: number;
}

// Board folders this file made, deleted after each test so the sidebar stays short.
const madeBoards: string[] = [];

/** Kanban's broker half, in memory: the boards and stages (as router folders), card state, every PUT. */
async function serveKanban(page: Page, request: APIRequestContext, base: string) {
  const boards: Array<{ folder: string; stages: Stage[]; tags: Tag[] }> = [];
  const cardTags: Record<string, string[]> = {};
  const cards: Record<string, { column: string; position: number; note: string; updated_by: string; updated_at: string }> = {};
  const puts: Array<{ id: string; body: { column: string } }> = [];
  const blockers: Record<string, string[]> = {};
  const details: Record<string, { description: string; priority: string }> = {};
  // Every board save and card-tag PUT, to count the requests.
  const saves: unknown[] = [];
  const tagPuts: Array<{ tags: string[]; create?: string[] }> = [];
  const related = (ids: string[]) => ids.map((b) => ({ id: b, title: b, stage: "Design", done: false }));
  // One card as the board reads it.
  const cardView = (id: string) => ({
    card: cards[id] ? { conversation_id: id, ...cards[id] } : null,
    blockers: related(blockers[id] ?? []),
    tags: cardTags[id] ?? [],
    priority: details[id]?.priority ?? "none",
  });
  // The conversation ids of each board read.
  const reads: string[][] = [];
  // Conversations whose card was read on its own.
  const cardReads: string[] = [];
  const folder = async (name: string, parentId?: string) =>
    ((await (await request.post(`${base}/folders`, { data: { name, parentId } })).json()) as { id: string }).id;
  const board = async (name: string) => {
    const made = { folder: await folder(name), stages: [] as Stage[], tags: [] as Tag[] };
    for (const [i, label] of STAGES.entries()) made.stages.push({ id: await folder(label, made.folder), label, position: i + 1 });
    boards.push(made);
    madeBoards.push(made.folder);
    return made;
  };
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        views: { boards: { contrib: "kanban", label: "Boards", order: 100, entry: "kanban/ui/Boards.tsx" } },
      }),
    }),
  );
  await page.route(/\/contrib-api\/kanban\/boards(\/[^/?]+)?$/, async (route) => {
    const id = /\/boards(?:\/([^/?]+))?$/.exec(route.request().url())![1];
    const method = route.request().method();
    const body = (route.request().postDataJSON() as { name?: string } | null) ?? {};
    const row = boards.find((b) => b.folder === id);
    let made: string | undefined;
    if (!id && method === "POST") made = (await board(body.name ?? "")).folder;
    if (row && method === "PATCH") await request.patch(`${base}/folders/${id}`, { data: { name: body.name } });
    if (row && method === "DELETE") {
      await request.delete(`${base}/folders/${id}?subfolders=delete`);
      boards.splice(boards.indexOf(row), 1);
    }
    if (row && method === "PUT") {
      // One save: the board's stages and tags, as wanted.
      const want = route.request().postDataJSON() as {
        stages: Array<{ id?: string; name: string }>;
        tags: Array<{ id?: string; name: string; color: string }>;
      };
      saves.push(want);
      const keep = new Set(want.stages.map((x) => x.id));
      for (const old of row.stages.filter((x) => !keep.has(x.id))) await request.delete(`${base}/folders/${old.id}`);
      const stages: Stage[] = [];
      for (const [i, x] of want.stages.entries()) {
        const sid = x.id ?? (await folder(x.name, row.folder));
        await request.patch(`${base}/folders/${sid}`, { data: { name: x.name, position: i + 1 } });
        stages.push({ id: sid, label: x.name, position: i + 1 });
      }
      const tags = want.tags.map((t, i) => ({ id: t.id ?? `tag-${Date.now()}-${i}`, name: t.name, color: t.color, position: i + 1 }));
      const ids = new Set(tags.map((t) => t.id));
      for (const k of Object.keys(cardTags)) cardTags[k] = cardTags[k].filter((x) => ids.has(x));
      Object.assign(row, { stages, tags });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ board: row }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ boards, folder: made }) });
  });
  await page.route(/\/conversations\/([^/]+)\/contrib-api\/kanban\/card\/tags$/, async (route) => {
    const id = /\/conversations\/([^/]+)\//.exec(route.request().url())![1];
    const body = route.request().postDataJSON() as { tags: string[]; board: string; create?: string[] };
    tagPuts.push(body);
    const row = boards.find((b) => b.folder === body.board)!;
    const created = (body.create ?? []).map((name, i) => ({ id: `tag-${Date.now()}-${i}`, name, color: "gray", position: row.tags.length + i + 1 }));
    row.tags.push(...created);
    cardTags[id] = [...body.tags, ...created.map((t) => t.id)];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tags: cardTags[id], created }) });
  });
  await page.route(/\/conversations\/([^/]+)\/contrib-api\/kanban\/card$/, async (route) => {
    const id = /\/conversations\/([^/]+)\//.exec(route.request().url())![1];
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { column: string; position: number };
      puts.push({ id, body });
      cards[id] = { note: cards[id]?.note ?? "", ...body, updated_by: "user", updated_at: new Date().toISOString() };
    } else {
      cardReads.push(id);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cardView(id)) });
  });
  await page.route(/\/contrib-api\/kanban\/boards\/([^/?]+)\/cards$/, async (route) => {
    const row = boards.find((b) => b.folder === /\/boards\/([^/?]+)\/cards$/.exec(route.request().url())![1]);
    const on = new Set([row?.folder, ...(row?.stages ?? []).map((s) => s.id)]);
    const { placements } = (await (await request.get(`${base}/folders`)).json()) as { placements: Record<string, string> };
    const asked = (route.request().postDataJSON() as { conversations: string[] }).conversations;
    const ids = asked.filter((id) => on.has(placements[id]));
    reads.push(ids);
    const body = { cards: Object.fromEntries(ids.map((id) => [id, cardView(id)])) };
    await route.fulfill({ status: row ? 200 : 404, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(/\/conversations\/([^/]+)\/contrib-api\/kanban\/card\/blockers$/, async (route) => {
    const id = /\/conversations\/([^/]+)\//.exec(route.request().url())![1];
    blockers[id] = (route.request().postDataJSON() as { blocked_by: string[] }).blocked_by;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ blockers: related(blockers[id]) }) });
  });
  await page.route(/\/conversations\/([^/]+)\/contrib-api\/kanban\/details$/, async (route) => {
    const id = /\/conversations\/([^/]+)\//.exec(route.request().url())![1];
    const row = (details[id] ??= { description: "", priority: "none" });
    if (route.request().method() === "PATCH") Object.assign(row, route.request().postDataJSON());
    const blocking = Object.keys(blockers).filter((k) => blockers[k].includes(id));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...row, updated_by: "user", updated_at: "", blocked_by: related(blockers[id] ?? []), blocking: related(blocking) }),
    });
  });
  return { boards, cards, cardTags, puts, board, blockers, details, saves, tagPuts, reads, cardReads };
}

const threadId = (page: Page) => new URL(page.url()).searchParams.get("thread");

/** The folder a conversation is filed in, as the router has it. */
async function filedIn(request: APIRequestContext, base: string, id: string) {
  return ((await (await request.get(`${base}/folders`)).json()) as { placements: Record<string, string> }).placements[id];
}

const lane = (page: Page, id: string) => page.locator(`[data-testid="kanban-lane"][data-column="${id}"]`);

fastOnly("the kanban broker routes are stubbed in the browser")("kanban /boards view", () => {
  test.afterEach(async ({ request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    for (const id of madeBoards.splice(0)) await request.delete(`${base}/folders/${id}?subfolders=delete`);
  });

  test("a board made on /boards shows its cards, a move files the conversation in the stage and is told to the agent, and a card opens its chat beside it", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const name = `e2e-board-${Date.now()}`;

    await chat.open();
    await chat.send("build the kanban board");
    await chat.waitForReply(/dummy agent/i);
    await expect.poll(() => threadId(page)).not.toBeNull();
    const id = threadId(page)!;

    // The header's switcher opens /boards, where a new board is made.
    await page.getByTestId("view-switch-boards").click();
    await page.waitForURL((u) => u.pathname === "/boards");
    await page.getByTestId("kanban-new-board-name").fill(name);
    await page.getByTestId("kanban-new-board").click();
    await expect.poll(() => kanban.boards.length).toBe(1);
    const [board] = kanban.boards;
    const [design, inProgress] = board.stages;
    kanban.cards[id] = { column: design.id, position: 0, note: "Drafting the design doc", updated_by: "agent", updated_at: new Date().toISOString() };
    await page.waitForURL((u) => u.pathname === `/boards/${board.folder}`);
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    expect((await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: design.id } })).ok()).toBeTruthy();

    const card = page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);
    await expect(lane(page, design.id).locator(card)).toHaveCount(1, { timeout: 20_000 });
    await expect(card.getByTestId("kanban-card-note")).toHaveText("Drafting the design doc");

    // A drag files the conversation and messages it.
    await card.dragTo(lane(page, inProgress.id));
    await expect(lane(page, inProgress.id).locator(card)).toHaveCount(1);
    await expect.poll(() => kanban.puts.map((p) => [p.id, p.body.column])).toEqual([[id, inProgress.id]]);
    await expect.poll(() => filedIn(request, base, id)).toBe(inProgress.id);

    // Opening the card shows its chat beside the board, with the move as a message.
    await card.getByRole("button").first().click();
    const side = page.getByTestId("kanban-chat");
    await expect(side).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === `/boards/${board.folder}`);
    await expect(side.getByText(/I moved this card from \*?\*?Design\*?\*? to \*?\*?In progress/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // The URL names the open card, so a reload shows its chat beside the board again.
    await expect.poll(() => threadId(page)).toBe(id);
    await page.reload();
    await expect(side).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute("data-open", "true");
    await expect(side.getByText(/I moved this card from/i).first()).toBeVisible({ timeout: 30_000 });

    // Closing the chat drops it from the URL, so a reload leaves it closed.
    await page.getByTestId("kanban-close-chat").click();
    await expect.poll(() => threadId(page)).toBeNull();

    // Switching conversations keeps the board's state: the chat stays beside it.
    await page.getByTestId("kanban-new").click();
    await expect(side).toBeVisible();
    await expect(card).not.toHaveAttribute("data-open");
  });

  test("the first stage's New conversation tile starts a conversation filed in it", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-tile-${Date.now()}`);
    const design = board.stages[0].id;
    const filedInDesign = async () => {
      const { placements } = (await (await request.get(`${base}/folders`)).json()) as { placements: Record<string, string> };
      return Object.values(placements).filter((f) => f === design).length;
    };

    // An empty board still shows its stages, the first with the tile.
    await page.goto(`/boards/${board.folder}`);
    await expect(page.getByTestId("kanban-lane")).toHaveCount(STAGES.length, { timeout: 20_000 });
    await expect(page.getByTestId("kanban-stage-new")).toHaveCount(1);

    await lane(page, design).getByTestId("kanban-stage-new").click();
    await expect(page.getByTestId("kanban-chat")).toBeVisible();
    await chat.send("started from the tile");
    await chat.waitForReply(/dummy agent/i);
    await expect.poll(filedInDesign, { timeout: 20_000 }).toBe(1);
    await expect(lane(page, design).getByTestId("kanban-card")).toHaveCount(1, { timeout: 20_000 });

    // Editing stages hides the tile.
    await page.getByTestId("kanban-edit-stages").click();
    await expect(page.getByTestId("kanban-stage-new")).toHaveCount(0);
  });

  test("filing a conversation in a stage's folder from outside moves its card", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-filed-${Date.now()}`);
    await chat.open();
    await chat.send("filed elsewhere");
    await chat.waitForReply(/dummy agent/i);
    await expect.poll(() => threadId(page)).not.toBeNull();
    const id = threadId(page)!;
    const card = page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);

    // The board folder itself shows as the first stage.
    await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: board.folder } });
    await page.goto(`/boards/${board.folder}`);
    await expect(lane(page, board.stages[0].id).locator(card)).toHaveCount(1, { timeout: 20_000 });
    await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: board.stages[2].id } });
    await expect(lane(page, board.stages[2].id).locator(card)).toHaveCount(1, { timeout: 20_000 });
  });

  test("a drop lands where it was dropped, and the lane keeps that order", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-order-${Date.now()}`);
    const design = board.stages[0].id;
    const ids: string[] = [];
    for (const text of ["first", "second", "third"]) {
      await chat.open();
      await page.locator('[data-testid="new-session"]').click();
      await chat.send(text);
      await chat.waitForReply(/dummy agent/i);
      await expect.poll(() => threadId(page)).not.toBe(ids.at(-1) ?? null);
      ids.push(threadId(page)!);
      await request.put(`${base}/conversations/${ids.at(-1)}/folder`, { data: { folderId: design } });
    }
    const order = () =>
      lane(page, design)
        .locator('[data-testid="kanban-card"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-conversation-id")));
    const card = (id: string) => page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);

    // No card has a position yet, so the newest shows first.
    await page.goto(`/boards/${board.folder}`);
    await expect.poll(order, { timeout: 20_000 }).toEqual([ids[2], ids[1], ids[0]]);

    // Dropping the bottom card on the top one puts it above, and a reload keeps that order.
    await card(ids[0]).dragTo(card(ids[2]));
    await expect.poll(order).toEqual([ids[0], ids[2], ids[1]]);
    await expect.poll(() => kanban.puts.length).toBe(3);
    await page.reload();
    await expect.poll(order, { timeout: 20_000 }).toEqual([ids[0], ids[2], ids[1]]);
  });

  test("the user adds, renames, reorders and deletes a board's stages", async ({ page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-stages-${Date.now()}`);
    const labels = () => page.getByTestId("kanban-lane").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    const childNames = async () => {
      const { folders } = (await (await request.get(`${base}/folders`)).json()) as {
        folders: Array<{ name: string; parentId?: string; position: number }>;
      };
      return folders.filter((f) => f.parentId === board.folder).sort((a, b) => a.position - b.position).map((f) => f.name);
    };

    await page.goto(`/boards/${board.folder}`);
    await page.getByTestId("kanban-edit-stages").click();
    await expect.poll(labels, { timeout: 20_000 }).toEqual(STAGES);

    await page.getByTestId("kanban-new-stage-name").fill("Backlog");
    await page.getByTestId("kanban-add-stage").getByRole("button", { name: /add stage/i }).click();
    await expect.poll(labels).toEqual([...STAGES, "Backlog"]);

    for (let i = 0; i < STAGES.length; i++) await page.getByRole("button", { name: "Move Backlog left" }).click();
    await expect.poll(labels).toEqual(["Backlog", ...STAGES]);

    page.once("dialog", (d) => void d.accept("QA"));
    await page.getByRole("button", { name: "Rename Review" }).click();
    await expect.poll(labels).toEqual(["Backlog", "Design", "In progress", "QA", "Done"]);

    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete Done" }).click();
    await expect.poll(labels).toEqual(["Backlog", "Design", "In progress", "QA"]);

    // Nothing is sent until Save, and then it is one request.
    await expect(page.getByTestId("kanban-unsaved")).toBeVisible();
    expect(kanban.saves).toHaveLength(0);
    expect(await childNames()).toEqual(STAGES);
    await expect(page.getByTestId("kanban-edit-stages")).toHaveText("Save");
    await page.getByTestId("kanban-edit-stages").click();
    await expect(page.getByTestId("kanban-edit-stages")).toHaveText("Edit board");
    expect(kanban.saves).toHaveLength(1);
    await expect.poll(labels).toEqual(["Backlog", "Design", "In progress", "QA"]);

    // Each stage is a folder inside the board's.
    await expect.poll(childNames).toEqual(["Backlog", "Design", "In progress", "QA"]);
  });

  test("Discard drops unsaved board edits, and leaving with some asks first", async ({ page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-unsaved-${Date.now()}`);
    const labels = () => page.getByTestId("kanban-lane").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    const rename = async (from: string, to: string) => {
      page.once("dialog", (d) => void d.accept(to));
      await page.getByRole("button", { name: `Rename ${from}` }).click();
    };

    await page.goto(`/boards/${board.folder}`);
    await page.getByTestId("kanban-edit-stages").click();
    await expect.poll(labels, { timeout: 20_000 }).toEqual(STAGES);
    await rename("Review", "QA");
    // Discard drops the edit and closes Edit board.
    await page.getByTestId("kanban-discard").click();
    await expect.poll(labels).toEqual(STAGES);
    await expect(page.getByTestId("kanban-unsaved")).toHaveCount(0);
    await expect(page.getByTestId("kanban-edit-stages")).toHaveText("Edit board");

    // Cancel stays on the board with the edit.
    await page.getByTestId("kanban-edit-stages").click();
    await rename("Review", "QA");
    const ask = page.getByTestId("kanban-save-changes");
    await page.getByTestId("kanban-all-boards").click();
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await expect.poll(labels).toEqual(["Design", "In progress", "QA", "Done"]);

    // Save saves it, then leaves.
    await page.getByTestId("kanban-all-boards").click();
    await ask.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("kanban-board")).toHaveCount(0);
    expect(kanban.saves).toHaveLength(1);
    expect(kanban.boards[0].stages.map((s) => s.label)).toEqual(["Design", "In progress", "QA", "Done"]);
  });

  test("the user makes a board's tags, tags a card by typing, and deleting a tag takes it off", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-tags-${Date.now()}`);
    await chat.open();
    await chat.send("tag me");
    await chat.waitForReply(/dummy agent/i);
    await expect.poll(() => threadId(page)).not.toBeNull();
    const id = threadId(page)!;
    await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: board.stages[0].id } });
    const card = page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);
    const chips = () => card.getByTestId("kanban-card-tags").getByTestId("kanban-tag").allTextContents();

    await page.goto(`/boards/${board.folder}`);
    await expect(card).toHaveCount(1, { timeout: 20_000 });

    await page.getByTestId("kanban-edit-stages").click();
    for (const [i, name] of ["bug", "infra"].entries()) {
      await page.getByTestId("kanban-new-tag-name").fill(name);
      await page.getByTestId("kanban-tags").getByRole("button", { name: /add tag/i }).click();
      await expect(page.getByTestId("kanban-tag-tools")).toHaveCount(i + 1);
    }
    await page.getByTestId("kanban-edit-stages").click();
    await expect.poll(() => kanban.boards[0].tags.map((t) => t.name)).toEqual(["bug", "infra"]);

    const field = card.getByRole("combobox", { name: "Add a tag" });
    const options = () => card.getByRole("option").allTextContents();
    const editing = () => card.getByTestId("kanban-tag-input").getByTestId("kanban-tag").allTextContents();
    await card.hover();
    await card.getByTestId("kanban-edit-card-tags").click();
    await expect(field).toBeFocused();

    // Typing filters; Enter adds, Backspace on empty removes the last.
    await field.fill("inf");
    await expect.poll(options).toEqual(["infra", "Create “inf”"]);
    await field.press("Enter");
    await expect.poll(editing).toEqual(["infra"]);
    await field.press("Backspace");
    await expect.poll(editing).toEqual([]);
    await field.fill("b");
    await card.getByRole("option", { name: "bug" }).click();
    await expect.poll(editing).toEqual(["bug"]);

    // An unknown name offers to create it, shown at once.
    await field.fill("ui");
    await card.getByRole("option", { name: "Create “ui”" }).click();
    await field.fill("inf");
    await field.press("Enter");
    await expect.poll(editing).toEqual(["bug", "ui", "infra"]);
    // × removes a tag.
    await card.getByRole("button", { name: "Remove infra" }).click();
    await expect.poll(editing).toEqual(["bug", "ui"]);

    // Closing sends one request, which also makes "ui".
    expect(kanban.tagPuts).toHaveLength(0);
    await field.press("Escape");
    await expect.poll(chips).toEqual(["bug", "ui"]);
    expect(kanban.tagPuts).toHaveLength(1);
    expect(kanban.tagPuts[0].create).toEqual(["ui"]);
    expect(kanban.boards[0].tags.map((t) => t.name)).toEqual(["bug", "infra", "ui"]);
    await expect.poll(() => kanban.cardTags[id]?.length).toBe(2);

    // The tags survive a reload, from the card route.
    await page.reload();
    await expect.poll(chips, { timeout: 20_000 }).toEqual(["bug", "ui"]);

    await page.getByTestId("kanban-edit-stages").click();
    page.once("dialog", (d) => {
      expect(d.message()).toContain("from 1 card");
      void d.accept();
    });
    await page.getByRole("button", { name: "Delete bug" }).click();
    await expect.poll(chips).toEqual(["ui"]);
    await page.getByTestId("kanban-edit-stages").click();
    await expect.poll(() => kanban.cardTags[id]?.length).toBe(1);
  });

  test("Rename and Delete board change the board's folder", async ({ page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const name = `e2e-board-off-${Date.now()}`;
    const board = await kanban.board(name);

    await page.goto(`/boards/${board.folder}`);
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    page.once("dialog", (d) => void d.accept(`${name}-renamed`));
    await page.getByTestId("kanban-rename-board").click();
    await expect(page.getByTestId("kanban-switch-board").locator("option:checked")).toHaveText(`${name}-renamed`);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("kanban-delete-board").click();
    await page.waitForURL((u) => u.pathname === "/boards");
    expect(kanban.boards).toEqual([]);
    const left = (await (await request.get(`${base}/folders`)).json()) as { folders: Array<{ id: string }> };
    const gone = [board.folder, ...board.stages.map((s) => s.id)];
    expect(left.folders.map((f) => f.id).filter((f) => gone.includes(f))).toEqual([]);
  });

  test("a blocked card shows how many cards it waits on", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-blockers-${Date.now()}`);
    const design = board.stages[0].id;
    const ids: string[] = [];
    for (const text of ["schema", "api"]) {
      await chat.open();
      await page.locator('[data-testid="new-session"]').click();
      await chat.send(text);
      await chat.waitForReply(/dummy agent/i);
      await expect.poll(() => threadId(page)).not.toBe(ids.at(-1) ?? null);
      ids.push(threadId(page)!);
      await request.put(`${base}/conversations/${ids.at(-1)}/folder`, { data: { folderId: design } });
    }
    const [schema, api] = ids;
    const card = (id: string) => page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);

    await page.goto(`/boards/${board.folder}`);
    await expect(card(api)).toBeVisible({ timeout: 20_000 });
    await expect(card(api)).not.toHaveAttribute("data-blocked");
    await expect(card(api).getByTestId("kanban-blocked-by")).toHaveCount(0);

    kanban.blockers[api] = [schema];
    await page.reload();
    await expect(card(api)).toHaveAttribute("data-blocked", "true", { timeout: 20_000 });
    await expect(card(api).getByTestId("kanban-blocked-by")).toHaveText("Blocked by 1");
    await expect(card(schema).getByTestId("kanban-blocked-by")).toHaveCount(0);
    // The board reads all its cards at once, never one by one.
    expect(kanban.reads.flat()).toEqual(expect.arrayContaining([schema, api]));
    expect(kanban.cardReads).toEqual([]);
  });

  test("the Details tab edits a card's priority, description and blockers, and keeps the chat", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page, request, base);
    const board = await kanban.board(`e2e-board-details-${Date.now()}`);
    const design = board.stages[0].id;
    const ids: string[] = [];
    for (const text of ["schema work", "api work"]) {
      await chat.open();
      await page.locator('[data-testid="new-session"]').click();
      await chat.send(text);
      await chat.waitForReply(/dummy agent/i);
      await expect.poll(() => threadId(page)).not.toBe(ids.at(-1) ?? null);
      ids.push(threadId(page)!);
      await request.put(`${base}/conversations/${ids.at(-1)}/folder`, { data: { folderId: design } });
    }
    const [schema, api] = ids;
    const card = (id: string) => page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);

    await page.goto(`/boards/${board.folder}`);
    await card(api).getByRole("button").first().click();
    const side = page.getByTestId("kanban-chat");
    await expect(side.getByTestId("kanban-tab-chat")).toHaveAttribute("aria-selected", "true");
    await side.getByTestId("kanban-tab-details").click();
    const details = side.getByTestId("kanban-details");
    await expect(details).toBeVisible();

    // High priority marks the card on the board.
    await expect(card(api).getByTestId("kanban-card-priority")).toHaveCount(0);
    await details.getByTestId("kanban-details-priority").selectOption("high");
    await expect.poll(() => kanban.details[api]?.priority).toBe("high");
    await expect(card(api).getByTestId("kanban-card-priority")).toHaveText("High");

    // The description saves on blur and renders as markdown.
    await details.getByTestId("kanban-description-add").click();
    await details.getByTestId("kanban-description-edit").fill("Add the **details** route");
    await details.getByText("Priority").click();
    await expect.poll(() => kanban.details[api]?.description).toBe("Add the **details** route");
    await expect(details.getByTestId("kanban-description").locator("strong")).toHaveText("details");

    // A blocker found by title blocks the card; removing it frees it.
    await details.getByTestId("kanban-add-blocker").click();
    await details.getByTestId("kanban-blocker-search").fill("schema");
    await details.getByTestId("kanban-blocker-choice").first().click();
    await expect.poll(() => kanban.blockers[api]).toEqual([schema]);
    await expect(details.getByTestId("kanban-related")).toHaveCount(1);
    await expect(card(api)).toHaveAttribute("data-blocked", "true");
    await details.getByTestId("kanban-remove-blocker").click();
    await expect.poll(() => kanban.blockers[api]).toEqual([]);
    await expect(card(api)).not.toHaveAttribute("data-blocked");

    // The blocked card lists what it blocks, read-only.
    kanban.blockers[api] = [schema];
    await card(schema).getByRole("button").first().click();
    await expect(details.getByTestId("kanban-details-blocking").getByTestId("kanban-related")).toHaveCount(1);
    await expect(details.getByTestId("kanban-remove-blocker")).toHaveCount(0);

    // Back on Chat, the open card's thread is there.
    await side.getByTestId("kanban-tab-chat").click();
    await expect(side.getByText(/schema work/).first()).toBeVisible();
  });
});
