/**
 * set_conversation_title: the agent's only way past the name-once gate on the `<title>`
 * marker. The gate itself is the session manager's (session.spec.ts); what matters here is
 * that a deliberate rename gets through it, that the user's own name never does, and that
 * the tool reports rather than errors when it declines — an erroring tool invites a retry
 * loop over a title nobody wants changed.
 */

import { beforeEach, describe, it, expect } from "vitest";

import {
  createSessionManager,
  isPlaceholderTitle,
  type SandboxProvisioner,
  type ConversationStore,
  type RouterMeta,
} from "../../src/session/manager.js";
import {
  handleSetConversationTitle,
  normalizeTitle,
  MAX_TITLE_LENGTH,
  type TitleToolsWiring,
} from "../../src/agent/titleTools.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: async (id) => ({ name: `conv-${id}`, namespace: "ns" }),
  suspend: async () => {},
  resume: async (ref) => ref,
  destroy: async () => {},
});

/** The conversations row as the conversation-router writes it. */
const routerRows = new Map<SessionId, Partial<RouterMeta>>();

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    readRouterMeta: async (id) => routerRows.get(id),
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

/** A user rename, which writes only the title columns of the row. */
const renameAsUser = (id: SessionId, title: string) =>
  routerRows.set(id, { ...routerRows.get(id), title, userTitled: true });

/** A conversation already named by its opening marker, plus the wiring index.ts builds. */
async function titledConversation(): Promise<{
  sessions: ReturnType<typeof createSessionManager>;
  titles: TitleToolsWiring;
}> {
  const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
  await sessions.start("t");
  expect(isPlaceholderTitle(sessions.get("t")?.title)).toBe(true);
  await sessions.setTitle("t", "Fix the login redirect");
  return {
    sessions,
    titles: {
      currentTitle: (id) => sessions.get(id)?.title,
      userTitled: async (id) => {
        await sessions.refreshRouterMeta(id as SessionId);
        return sessions.get(id)?.userTitled === true;
      },
      setTitle: (id, title) => sessions.setTitle(id, title, { force: true }),
    },
  };
}

describe("set_conversation_title", () => {
  beforeEach(() => routerRows.clear());

  it("renames a conversation the marker gate has already closed on", async () => {
    const { sessions, titles } = await titledConversation();
    const res = await handleSetConversationTitle(titles, "t", { title: "Migrate the auth service" });
    expect(res.isError).toBeFalsy();
    expect(sessions.get("t")?.title).toBe("Migrate the auth service");
  });

  it("refuses to overwrite a title the USER chose, and says so without erroring", async () => {
    const { sessions, titles } = await titledConversation();
    renameAsUser("t", "Mine");
    const res = await handleSetConversationTitle(titles, "t", { title: "Mine, actually" });
    // Not an error: the agent should stop, not retry.
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/named by the user|locked/i);
    expect(sessions.get("t")?.title).toBe("Mine");
  });

  it("rejects a blank title without touching the conversation", async () => {
    const { sessions, titles } = await titledConversation();
    const res = await handleSetConversationTitle(titles, "t", { title: "   " });
    expect(res.isError).toBe(true);
    expect(sessions.get("t")?.title).toBe("Fix the login redirect");
  });

  it("reports a no-op when the title already says what was asked for", async () => {
    const { titles } = await titledConversation();
    const res = await handleSetConversationTitle(titles, "t", { title: "Fix the login redirect" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/no change/i);
  });

  it("does not LOCK the title — the user can still rename afterwards", async () => {
    const { sessions, titles } = await titledConversation();
    await handleSetConversationTitle(titles, "t", { title: "The agent's choice" });
    expect(sessions.get("t")?.userTitled).toBeFalsy();
    renameAsUser("t", "Mine");
    await sessions.refreshRouterMeta("t");
    expect(sessions.get("t")?.title).toBe("Mine");
  });

  it("collapses whitespace and clips an over-long title", () => {
    expect(normalizeTitle("  Fix   the\nlogin  redirect ")).toBe("Fix the login redirect");
    expect(normalizeTitle("x".repeat(MAX_TITLE_LENGTH + 50)).length).toBe(MAX_TITLE_LENGTH);
  });
});
