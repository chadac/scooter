/**
 * ThreadPrimitive.Messages memoizes its rendered message array on
 * [messagesLength, children]. A `children` prop whose identity changes each
 * render busts that memo, so every commit rebuilds one element per message —
 * 372ms per commit at 1,555 messages, measured, with only 4 fibers re-rendering.
 * The callback must therefore be a stable reference, not an inline arrow.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../components/assistant-ui/thread.tsx", import.meta.url),
  "utf8",
);

describe("ThreadPrimitive.Messages children", () => {
  it("is passed a stable reference, not an inline function", () => {
    const call = src.match(/<ThreadPrimitive\.Messages>([\s\S]*?)<\/ThreadPrimitive\.Messages>/);
    expect(call, "ThreadPrimitive.Messages call site not found").not.toBeNull();
    const children = call![1].trim();
    expect(children, `inline callback passed to ThreadPrimitive.Messages: ${children}`)
      .not.toMatch(/=>/);
    expect(children).toMatch(/^\{[A-Za-z_$][\w$]*\}$/);
  });

  it("defines that callback at module scope so its identity never changes", () => {
    const name = src
      .match(/<ThreadPrimitive\.Messages>\{([A-Za-z_$][\w$]*)\}<\/ThreadPrimitive\.Messages>/)?.[1];
    expect(name).toBeTruthy();
    expect(src).toMatch(new RegExp(`^const ${name} = `, "m"));
  });
});
