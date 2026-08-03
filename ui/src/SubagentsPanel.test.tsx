/**
 * UI unit test — the Subagents panel view (pure) + subagentsOf selector.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentsPanelView, subagentsOf } from "./SubagentsPanel.js";
import type { Session } from "./sessions.js";

const s = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: 1,
  ...over,
});

const noop = () => {};

describe("subagentsOf", () => {
  it("returns only the children of the given parent", () => {
    const all = [s("p"), s("c1", { parentId: "p" }), s("other"), s("c2", { parentId: "p" })];
    expect(subagentsOf(all, "p").map((x) => x.id).sort()).toEqual(["c1", "c2"]);
  });
  it("returns [] for no parent id", () => {
    expect(subagentsOf([s("a")], undefined)).toEqual([]);
  });
});

describe("SubagentsPanelView", () => {
  it("empty: shows the no-subagents hint", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsPanelView, { subagents: [], onOpen: noop, onCancel: noop }),
    );
    expect(html).toContain("subagents-empty");
    expect(html).not.toContain("subagents-list");
  });

  it("lists subagents with an open button", () => {
    const subs = [s("sub-a", { title: "research A", status: "running" }), s("sub-b", { title: "research B", status: "ended" })];
    const html = renderToStaticMarkup(
      createElement(SubagentsPanelView, { subagents: subs, onOpen: noop, onCancel: noop }),
    );
    expect(html).toContain("subagents-list");
    expect(html).toContain("research A");
    expect(html).toContain("research B");
    expect(html).toContain("subagent-open");
  });

  it("shows a Stop button only for a RUNNING subagent", () => {
    const running = renderToStaticMarkup(
      createElement(SubagentsPanelView, { subagents: [s("r", { status: "running" })], onOpen: noop, onCancel: noop }),
    );
    expect(running).toContain("subagent-cancel");
    const ended = renderToStaticMarkup(
      createElement(SubagentsPanelView, { subagents: [s("e", { status: "ended" })], onOpen: noop, onCancel: noop }),
    );
    expect(ended).not.toContain("subagent-cancel");
  });
});
