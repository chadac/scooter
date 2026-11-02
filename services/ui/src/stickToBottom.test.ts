/** The thread viewport's stick-to-bottom lock, driven against a fake viewport and frame clock. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachStickToBottom } from "./stickToBottom.js";

/** A scroll container whose scrollTop clamps like a browser's; scroll events are fired by the test. */
class FakeViewport extends EventTarget {
  scrollHeight = 2000;
  clientHeight = 500;
  firstElementChild = null;
  private top = 0;
  get scrollTop() {
    return this.top;
  }
  set scrollTop(v: number) {
    this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
  }
  querySelector() {
    return null;
  }
  distanceFromBottom() {
    return this.scrollHeight - this.top - this.clientHeight;
  }
  /** The user scrolls by `dy`: the input event, then the scroll it causes. */
  wheel(dy: number) {
    this.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: dy }));
    this.scrollTop = this.top + dy;
    this.dispatchEvent(new Event("scroll"));
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resized: () => void;

/** Run every queued animation frame once, as one browser frame does. */
function frame() {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
}

/** Content grows, as a streaming turn does, and the ResizeObserver reports it. */
function grow(el: FakeViewport, by = 100) {
  el.scrollHeight += by;
  resized();
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function attach() {
  const el = new FakeViewport();
  const detach = attachStickToBottom(el as unknown as HTMLElement, () => {});
  for (let i = 0; i < 10; i++) frame();
  return { el, detach };
}

describe("attachStickToBottom", () => {
  it("follows content growth to the bottom", () => {
    const { el } = attach();
    grow(el, 300);
    expect(el.distanceFromBottom()).toBe(0);
  });

  it("an upward wheel mid-pin releases the lock (the scroll-lock nightly flake)", () => {
    const { el } = attach();
    // A streaming turn re-pins, so its own scroll guard is up when the user wheels.
    grow(el);
    el.wheel(-600);
    for (let i = 0; i < 10; i++) frame();
    // The turn keeps streaming, then finishes; neither may drag the view back down.
    grow(el);
    for (let i = 0; i < 10; i++) frame();
    expect(el.distanceFromBottom()).toBeGreaterThan(500);
  });

  it("an upward wheel cancels assistant-ui's pending scroll-to-bottom", () => {
    const { el } = attach();
    const pointerdown = vi.fn();
    el.addEventListener("pointerdown", pointerdown);
    el.wheel(-600);
    expect(pointerdown).toHaveBeenCalledTimes(1);
  });

  it("a downward wheel keeps the lock", () => {
    const { el } = attach();
    grow(el);
    el.wheel(200);
    grow(el);
    expect(el.distanceFromBottom()).toBe(0);
  });

  it("a downward touch drag releases the lock", () => {
    const { el } = attach();
    const touch = (type: string, y: number) =>
      el.dispatchEvent(Object.assign(new Event(type), { touches: [{ clientY: y }] }));
    grow(el);
    touch("touchstart", 100);
    touch("touchmove", 400);
    el.scrollTop -= 300;
    for (let i = 0; i < 10; i++) frame();
    grow(el);
    expect(el.distanceFromBottom()).toBeGreaterThan(300);
  });

  it("scrolling back to the bottom re-engages the lock", () => {
    const { el } = attach();
    el.wheel(-600);
    frame();
    el.wheel(600);
    frame();
    grow(el);
    expect(el.distanceFromBottom()).toBe(0);
  });
});
