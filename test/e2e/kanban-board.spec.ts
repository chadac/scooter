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

/** Kanban's broker half, in memory: the boards and stages (as router folders), card state, every PUT. */
async function serveKanban(page: Page, request: APIRequestContext, base: string) {
  const boards: Array<{ folder: string; stages: Stage[] }> = [];
  const cards: Record<string, { column: string; position: number; note: string; updated_by: string; updated_at: string }> = {};
  const puts: Array<{ id: string; body: { column: string } }> = [];
  const folder = async (name: string, parentId?: string) =>
    ((await (await request.post(`${base}/folders`, { data: { name, parentId } })).json()) as { id: string }).id;
  const board = async (name: string) => {
    const made = { folder: await folder(name), stages: [] as Stage[] };
    for (const [i, label] of STAGES.entries()) made.stages.push({ id: await folder(label, made.folder), label, position: i + 1 });
    boards.push(made);
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
  await page.route(/\/contrib-api\/kanban\/boards(\/[^/?]+)?(\/stages(\/[^/?]+)?)?$/, async (route) => {
    const m = /\/boards(?:\/([^/?]+))?(?:\/stages(?:\/([^/?]+))?)?$/.exec(route.request().url())!;
    const [id, stage] = [m[1], m[2]];
    const isStages = route.request().url().includes("/stages");
    const method = route.request().method();
    const body = (route.request().postDataJSON() as { name?: string; position?: number } | null) ?? {};
    const row = boards.find((b) => b.folder === id);
    let made: string | undefined;
    if (!id && method === "POST") made = (await board(body.name ?? "")).folder;
    if (row && !isStages && method === "PATCH") await request.patch(`${base}/folders/${id}`, { data: { name: body.name } });
    if (row && !isStages && method === "DELETE") {
      await request.delete(`${base}/folders/${id}?subfolders=delete`);
      boards.splice(boards.indexOf(row), 1);
    }
    if (row && isStages && !stage && method === "POST") {
      const at = (row.stages.at(-1)?.position ?? 0) + 1;
      row.stages.push({ id: await folder(body.name ?? "", row.folder), label: body.name ?? "", position: at });
    }
    const s = row?.stages.find((x) => x.id === stage);
    if (row && s && method === "PATCH") {
      await request.patch(`${base}/folders/${s.id}`, { data: body });
      Object.assign(s, { label: body.name ?? s.label, position: body.position ?? s.position });
      row.stages.sort((a, b) => a.position - b.position);
    }
    if (row && s && method === "DELETE") {
      await request.delete(`${base}/folders/${s.id}`);
      row.stages.splice(row.stages.indexOf(s), 1);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ boards, folder: made }) });
  });
  await page.route(/\/conversations\/([^/]+)\/contrib-api\/kanban\/card$/, async (route) => {
    const id = /\/conversations\/([^/]+)\//.exec(route.request().url())![1];
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { column: string; position: number };
      puts.push({ id, body });
      cards[id] = { note: cards[id]?.note ?? "", ...body, updated_by: "user", updated_at: new Date().toISOString() };
    }
    const card = cards[id] ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ card: card && { conversation_id: id, ...card } }),
    });
  });
  return { boards, cards, puts, board };
}

const threadId = (page: Page) => new URL(page.url()).searchParams.get("thread");

/** The folder a conversation is filed in, as the router has it. */
async function filedIn(request: APIRequestContext, base: string, id: string) {
  return ((await (await request.get(`${base}/folders`)).json()) as { placements: Record<string, string> }).placements[id];
}

const lane = (page: Page, id: string) => page.locator(`[data-testid="kanban-lane"][data-column="${id}"]`);

fastOnly("the kanban broker routes are stubbed in the browser")("kanban /boards view", () => {
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

    // Switching conversations keeps the board's state: the chat stays beside it.
    await page.getByTestId("kanban-new").click();
    await expect(side).toBeVisible();
    await expect(card).not.toHaveAttribute("data-open");
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

    // Each stage is a folder inside the board's.
    await expect.poll(childNames).toEqual(["Backlog", "Design", "In progress", "QA"]);
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
});
