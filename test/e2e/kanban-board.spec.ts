/**
 * Tier 3 E2E for contrib views, through kanban's /boards: a folder opted in on /boards
 * shows as a board, its conversations are cards in their columns, a move is saved and
 * told to that conversation, and a card opens its chat beside the board. The manifest
 * and kanban's broker routes are stubbed, since the fast stack has no broker; the view
 * is the kanban contrib's real module.
 */

import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const COLUMNS = [
  { id: "design", label: "Design" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Kanban's broker half, in memory: the boards, card state per conversation, every PUT. */
async function serveKanban(page: Page) {
  const boards: string[] = [];
  const cards: Record<string, { column: string; position: number; note: string; updated_by: string; updated_at: string }> = {};
  const puts: Array<{ id: string; body: { column: string } }> = [];
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
    const folder = /\/boards\/([^/?]+)$/.exec(route.request().url())?.[1];
    const method = route.request().method();
    if (folder && method === "PUT" && !boards.includes(folder)) boards.push(folder);
    if (folder && method === "DELETE") boards.splice(boards.indexOf(folder) >>> 0, 1);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ boards, columns: COLUMNS }) });
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
      body: JSON.stringify({ card: card && { conversation_id: id, ...card }, column: card?.column ?? "design", columns: COLUMNS, stale: !card }),
    });
  });
  return { boards, cards, puts };
}

const threadId = (page: Page) => new URL(page.url()).searchParams.get("thread");

fastOnly("the kanban broker routes are stubbed in the browser")("kanban /boards view", () => {
  test("a folder opted in is a board, a move is saved and told to the agent, and a card opens its chat beside it", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page);
    const name = `e2e-board-${Date.now()}`;
    const folder = (await (await request.post(`${base}/folders`, { data: { name } })).json()) as { id: string };

    await chat.open();
    await chat.send("build the kanban board");
    await chat.waitForReply(/dummy agent/i);
    await expect.poll(() => threadId(page)).not.toBeNull();
    const id = threadId(page)!;
    expect((await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: folder.id } })).ok()).toBeTruthy();
    kanban.cards[id] = { column: "design", position: 0, note: "Drafting the design doc", updated_by: "agent", updated_at: new Date().toISOString() };

    // The header's switcher opens /boards, where the folder is opted in as a board.
    await page.getByTestId("view-switch-boards").click();
    await page.waitForURL((u) => u.pathname === "/boards");
    await page.locator(`[data-testid="kanban-make-board"][data-folder-id="${folder.id}"]`).click({ timeout: 20_000 });
    await page.waitForURL((u) => u.pathname === `/boards/${folder.id}`);
    expect(kanban.boards).toEqual([folder.id]);

    const card = page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);
    await expect(page.locator('[data-testid="kanban-lane"][data-column="design"]').locator(card)).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(card.getByTestId("kanban-card-note")).toHaveText("Drafting the design doc");

    // Dragging the card to another column saves it, then messages that conversation as the user.
    await card.dragTo(page.locator('[data-testid="kanban-lane"][data-column="in-progress"]'));
    await expect(page.locator('[data-testid="kanban-lane"][data-column="in-progress"]').locator(card)).toHaveCount(1);
    await expect.poll(() => kanban.puts.map((p) => [p.id, p.body.column])).toEqual([[id, "in-progress"]]);

    // Opening the card shows its chat beside the board, with the move as a message.
    await card.getByRole("button").first().click();
    const side = page.getByTestId("kanban-chat");
    await expect(side).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === `/boards/${folder.id}`);
    await expect(side.getByText(/I moved this card from \*?\*?Design\*?\*? to \*?\*?In progress/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // Switching conversations keeps the board's state: the chat stays beside it.
    await page.getByTestId("kanban-new").click();
    await expect(side).toBeVisible();
    await expect(card).not.toHaveAttribute("data-open");
  });

  test("a drop lands where it was dropped, and the lane keeps that order", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page);
    const folder = (await (await request.post(`${base}/folders`, { data: { name: `e2e-board-order-${Date.now()}` } })).json()) as { id: string };
    kanban.boards.push(folder.id);
    const ids: string[] = [];
    for (const text of ["first", "second", "third"]) {
      await chat.open();
      await page.locator('[data-testid="new-session"]').click();
      await chat.send(text);
      await chat.waitForReply(/dummy agent/i);
      await expect.poll(() => threadId(page)).not.toBe(ids.at(-1) ?? null);
      ids.push(threadId(page)!);
      await request.put(`${base}/conversations/${ids.at(-1)}/folder`, { data: { folderId: folder.id } });
    }
    const order = () =>
      page
        .locator('[data-testid="kanban-lane"][data-column="design"] [data-testid="kanban-card"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-conversation-id")));
    const card = (id: string) => page.locator(`[data-testid="kanban-card"][data-conversation-id="${id}"]`);

    // No card has a position yet, so the newest shows first.
    await page.goto(`/boards/${folder.id}`);
    await expect.poll(order, { timeout: 20_000 }).toEqual([ids[2], ids[1], ids[0]]);

    // Dropping the bottom card on the top one puts it above, and a reload keeps that order.
    await card(ids[0]).dragTo(card(ids[2]));
    await expect.poll(order).toEqual([ids[0], ids[2], ids[1]]);
    await expect.poll(() => kanban.puts.length).toBe(3);
    await page.reload();
    await expect.poll(order, { timeout: 20_000 }).toEqual([ids[0], ids[2], ids[1]]);
  });

  test("Remove board leaves the folder and lists it as a folder again", async ({ page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const kanban = await serveKanban(page);
    const name = `e2e-board-off-${Date.now()}`;
    const folder = (await (await request.post(`${base}/folders`, { data: { name } })).json()) as { id: string };
    kanban.boards.push(folder.id);

    await page.goto(`/boards/${folder.id}`);
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("kanban-remove-board").click();
    await page.waitForURL((u) => u.pathname === "/boards");
    await expect(page.locator(`[data-testid="kanban-make-board"][data-folder-id="${folder.id}"]`)).toBeVisible();
    expect(kanban.boards).toEqual([]);
  });
});
