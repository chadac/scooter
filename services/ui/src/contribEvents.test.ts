import { describe, expect, it, vi } from "vitest";

import { createContribEvents } from "./contribEvents.js";

describe("contribEvents", () => {
  it("reaches only the named contrib's listeners", () => {
    const events = createContribEvents();
    const notes = vi.fn();
    const other = vi.fn();
    events.on("notes", notes);
    events.on("shares", other);
    events.emit("notes", ["c1"]);
    expect(notes).toHaveBeenCalledWith(["c1"]);
    expect(other).not.toHaveBeenCalled();
  });

  it("tells every contrib after a reconnect, and stops after unsubscribe", () => {
    const events = createContribEvents();
    const notes = vi.fn();
    const off = events.on("notes", notes);
    events.emitAll();
    expect(notes).toHaveBeenCalledWith([]);
    off();
    events.emit("notes", ["c1"]);
    expect(notes).toHaveBeenCalledTimes(1);
  });
});
