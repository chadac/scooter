/** The Chats panel view (pure). */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatsPanelView } from "./ChatsPanel.js";
import { familyOf } from "./family.js";
import type { Session } from "./sessions.js";

const s = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: 1,
  lastActivityAt: 1,
  ...over,
});

const noop = () => {};
const view = (members: ReturnType<typeof familyOf>, over: { onNew?: () => void; currentId?: string } = {}) =>
  renderToStaticMarkup(
    createElement(ChatsPanelView, { members, currentId: over.currentId, onOpen: noop, onStop: noop, onNew: over.onNew }),
  );

describe("ChatsPanelView", () => {
  const family = familyOf(
    [
      s("p", { status: "running" }),
      s("sub", { parentId: "p", kind: "subagent", status: "running", createdAt: 2 }),
      s("web", { parentId: "p", kind: "session", origin: "web", status: "running", createdAt: 3 }),
      s("done", { parentId: "p", kind: "session", origin: "vscode", status: "ended", createdAt: 4 }),
    ],
    "p",
  );

  it("lists the conversation first, then sessions, then subagents, marking the current one", () => {
    const html = view(family, { currentId: "web" });
    expect([...html.matchAll(/data-kind="([a-z]+)"/g)].map((m) => m[1])).toEqual(["root", "session", "session", "subagent"]);
    expect(html).toMatch(/data-kind="session" data-current="true"/);
    expect(html).toContain('data-origin="web"');
    expect(html).toContain('data-origin="vscode"');
  });

  it("offers Stop only on children that have not ended", () => {
    const html = view(family);
    expect(html.match(/data-testid="chat-stop"/g)).toHaveLength(2);
  });

  it("disables New session when none can start", () => {
    expect(view(family)).toMatch(/disabled=""[^>]*data-testid="chats-new-session"|data-testid="chats-new-session"[^>]*disabled=""/);
    expect(view(family, { onNew: noop })).not.toMatch(/data-testid="chats-new-session"[^>]*disabled/);
  });
});
