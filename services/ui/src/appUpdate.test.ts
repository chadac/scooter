// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HIDDEN_RELOAD_MS,
  fetchDeployedBuild,
  installChunkRecovery,
  pageBuild,
  reloadInto,
  reloadWouldLoseWork,
  updateStore,
  watchForUpdates,
  withReloadHold,
} from "./appUpdate.js";
import { pruneApprovals, setDraft } from "./approvalFocus.js";
import type { VisibilityHost } from "./visiblePoll.js";

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
    set(next: boolean) {
      visible = next;
      for (const cb of [...subs]) cb();
    },
  };
}

const serving = (build: unknown, ok = true) =>
  vi.fn(async () => new Response(JSON.stringify({ build }), { status: ok ? 200 : 503 })) as unknown as typeof fetch;

beforeEach(() => {
  updateStore.reset();
  document.body.innerHTML = "";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  pruneApprovals([]);
});

describe("pageBuild", () => {
  it("reads the meta tag, or null without one", () => {
    expect(pageBuild()).toBeNull();
    document.head.innerHTML = '<meta name="scooter-build" content="abc">';
    expect(pageBuild()).toBe("abc");
    document.head.innerHTML = "";
  });
});

describe("fetchDeployedBuild", () => {
  it("returns the build, and null for errors or junk", async () => {
    expect(await fetchDeployedBuild(serving("b2"))).toBe("b2");
    expect(await fetchDeployedBuild(serving("b2", false))).toBeNull();
    expect(await fetchDeployedBuild(serving(42))).toBeNull();
    const html = vi.fn(async () => new Response("<!doctype html>")) as unknown as typeof fetch;
    expect(await fetchDeployedBuild(html)).toBeNull();
    const down = vi.fn(async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    expect(await fetchDeployedBuild(down)).toBeNull();
  });
});

describe("watchForUpdates", () => {
  it("flags a different build and ignores the same one", async () => {
    const same = watchForUpdates({ current: "b1", fetchImpl: serving("b1"), visibility: fakeHost().host });
    await same.check();
    expect(updateStore.get().available).toBe(false);
    same.stop();

    const other = watchForUpdates({ current: "b1", fetchImpl: serving("b2"), visibility: fakeHost().host });
    await other.check();
    expect(updateStore.get()).toEqual({ available: true, build: "b2", dismissed: false });
    other.stop();
  });

  it("polls only while visible", async () => {
    const fetchImpl = serving("b1");
    const v = fakeHost();
    const w = watchForUpdates({ current: "b1", fetchImpl, visibility: v.host });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    v.set(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("reloads a tab hidden for the whole stretch, and not one that came back", async () => {
    const reload = vi.fn();
    const v = fakeHost();
    const w = watchForUpdates({ current: "b1", fetchImpl: serving("b2"), visibility: v.host, reload, wouldLoseWork: () => false });
    await w.check();

    v.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_MS - 1000);
    v.set(true);
    v.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_MS - 1000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("arms when the update is found while already hidden", async () => {
    const reload = vi.fn();
    const v = fakeHost(false);
    const w = watchForUpdates({ current: "b1", fetchImpl: serving("b2"), visibility: v.host, reload, wouldLoseWork: () => false });
    await w.check();
    await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("does not reload over unsaved work", async () => {
    const reload = vi.fn();
    const v = fakeHost(false);
    const w = watchForUpdates({ current: "b1", fetchImpl: serving("b2"), visibility: v.host, reload, wouldLoseWork: () => true });
    await w.check();
    await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_MS);
    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });
});

describe("updateStore", () => {
  it("keeps a dismissal for the same build and drops it for a newer one", () => {
    updateStore.markAvailable("b2");
    updateStore.dismiss();
    updateStore.markAvailable("b2");
    expect(updateStore.get().dismissed).toBe(true);
    updateStore.markAvailable("b3");
    expect(updateStore.get()).toEqual({ available: true, build: "b3", dismissed: false });
  });
});

describe("reloadWouldLoseWork", () => {
  it("is false on an empty page", () => {
    document.body.innerHTML = '<textarea class="aui-composer-input"></textarea><input type="checkbox" checked><textarea aria-hidden="true"></textarea>';
    document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]')!.value = "x";
    expect(reloadWouldLoseWork()).toBe(false);
  });

  it("sees typed text, an attachment, a dialog and an approval draft", () => {
    document.body.innerHTML = "<textarea></textarea>";
    document.querySelector("textarea")!.value = "half a thought";
    expect(reloadWouldLoseWork()).toBe(true);

    document.body.innerHTML = '<div class="aui-composer-root"><div class="aui-attachment-root"></div></div>';
    expect(reloadWouldLoseWork()).toBe(true);

    document.body.innerHTML = '<div role="dialog"></div>';
    expect(reloadWouldLoseWork()).toBe(true);

    document.body.innerHTML = "";
    setDraft("req-1", { answer: "yes" });
    expect(reloadWouldLoseWork()).toBe(true);
  });

  it("holds while a send is in flight", async () => {
    let finish!: () => void;
    const send = withReloadHold(() => new Promise<void>((r) => (finish = r)));
    const sent = send();
    expect(reloadWouldLoseWork()).toBe(true);
    finish();
    await sent;
    expect(reloadWouldLoseWork()).toBe(false);
  });
});

describe("reloadInto", () => {
  it("loads the conversation fresh only when an update waits and nothing would be lost", () => {
    const assign = vi.fn();
    expect(reloadInto("c1", { assign, wouldLoseWork: () => false })).toBe(false);

    updateStore.markAvailable("b2");
    expect(reloadInto(undefined, { assign, wouldLoseWork: () => false })).toBe(false);
    expect(reloadInto("c1", { assign, wouldLoseWork: () => true })).toBe(false);
    expect(assign).not.toHaveBeenCalled();

    expect(reloadInto("c1", { assign, wouldLoseWork: () => false })).toBe(true);
    expect(new URL(assign.mock.calls[0][0]).searchParams.get("thread")).toBe("c1");
  });
});

describe("installChunkRecovery", () => {
  it("reloads once, then checks instead within the gap or over unsaved work", () => {
    sessionStorage.clear();
    const reload = vi.fn();
    const check = vi.fn(async () => {});
    let t = 1_000_000;
    let busy = false;
    installChunkRecovery(check, { now: () => t, reload, wouldLoseWork: () => busy });
    const fire = () => window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    fire();
    expect(reload).toHaveBeenCalledTimes(1);
    t += 30_000;
    fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);

    t += 60_000;
    busy = true;
    fire();
    expect(reload).toHaveBeenCalledTimes(1);
    busy = false;
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
