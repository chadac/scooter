/**
 * A hidden tab must issue no polls, and must not wait out a full interval before showing
 * fresh data when it comes back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { pollWhileVisible, type VisibilityHost } from "./visiblePoll.js";

/** A controllable stand-in for document.visibilityState. */
function fakeHost(initiallyVisible = true) {
  let visible = initiallyVisible;
  const subs = new Set<() => void>();
  const host: VisibilityHost = {
    visible: () => visible,
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return {
    host,
    subscriberCount: () => subs.size,
    set(next: boolean) {
      visible = next;
      for (const cb of [...subs]) cb();
    },
  };
}

describe("pollWhileVisible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not tick on start, leaving the first read to the caller", () => {
    const tick = vi.fn();
    pollWhileVisible(tick, 1000, fakeHost().host);
    expect(tick).not.toHaveBeenCalled();
  });

  it("ticks on the interval while visible", () => {
    const tick = vi.fn();
    pollWhileVisible(tick, 1000, fakeHost().host);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("issues NOT ONE poll while hidden, however long it stays hidden", () => {
    const tick = vi.fn();
    const h = fakeHost();
    pollWhileVisible(tick, 1000, h.host);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    h.set(false);
    vi.advanceTimersByTime(60 * 60 * 1000); // an hour backgrounded
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("never starts a timer for a tab that is already hidden", () => {
    const tick = vi.fn();
    pollWhileVisible(tick, 1000, fakeHost(false).host);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("catches up immediately on becoming visible, then resumes the interval", () => {
    const tick = vi.fn();
    const h = fakeHost();
    pollWhileVisible(tick, 1000, h.host);
    h.set(false);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();

    h.set(true);
    expect(tick).toHaveBeenCalledTimes(1); // the catch-up read, not a full interval later
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("does not double-tick when a visible tab reports visibility again", () => {
    // Some browsers fire visibilitychange on focus transitions that leave the tab visible.
    const tick = vi.fn();
    const h = fakeHost();
    pollWhileVisible(tick, 1000, h.host);
    h.set(true);
    h.set(true);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1); // one timer, not three
  });

  it("stop() ends the polling and unsubscribes", () => {
    const tick = vi.fn();
    const h = fakeHost();
    const stop = pollWhileVisible(tick, 1000, h.host);
    stop();
    expect(h.subscriberCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    // A visibility change after stop must not revive it.
    h.set(false);
    h.set(true);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe("the UI's repeating polls are visibility-gated", () => {
  // A bare setInterval here is the regression this module exists to prevent.
  const sources = {
    "conversationState.ts": "the state stream's while-down fallback",
  };

  for (const [file, what] of Object.entries(sources)) {
    it(`${file}: ${what} goes through pollWhileVisible`, () => {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(src).toContain("pollWhileVisible");
      expect(src, "a raw setInterval re-polls hidden tabs").not.toMatch(/setInterval\(/);
    });
  }

  // The conversation state stream pushes these.
  const pushed = {
    "SandboxPanel.tsx": "sandbox status and services",
    "LinkedResources.tsx": "linked resources",
    "../../../contrib/shares/ui/Panel.tsx": "the Shares section",
  };
  for (const [file, what] of Object.entries(pushed)) {
    it(`${file}: ${what} is pushed, not polled`, () => {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(src, "a poll coming back is the regression").not.toMatch(/pollWhileVisible|setInterval\(/);
    });
  }

  it("main.tsx polls the conversation list NOT AT ALL — the stream is its only source", () => {
    // This was the UI's largest source of requests (6/min/tab, every tab, forever). The
    // stream replaced it, so the regression to guard is a poll coming BACK, under either
    // name. Why: PR #780.
    const src = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(src, "the conversation list has one source: the stream").not.toMatch(/pollWhileVisible|setInterval\(/);
    expect(src, "a periodic full-list read is what this removed").not.toMatch(/loadConversations/);
  });
});
