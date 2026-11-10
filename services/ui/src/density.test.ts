import { describe, expect, it } from "vitest";

import { densityFromQuery, densityStorageKey, initialDensity } from "./density.js";

const storage = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });

describe("density", () => {
  it("defaults to what the framing page asks for", () => {
    expect(densityFromQuery("?density=compact")).toBe("compact");
    expect(densityFromQuery("?chat=x")).toBe("comfortable");
    expect(densityFromQuery("?density=tiny")).toBe("comfortable");
  });

  it("starts from the user's choice for this host default", () => {
    const s = storage({ [densityStorageKey("compact")]: "comfortable" });
    expect(initialDensity("?density=compact", s)).toBe("comfortable");
    // A choice made under compact hosts doesn't reach hosts that never asked for compact.
    expect(initialDensity("", s)).toBe("comfortable");
    expect(initialDensity("", storage({ [densityStorageKey("compact")]: "compact" }))).toBe("comfortable");
  });

  it("falls back to the host default when storage is unavailable or garbled", () => {
    expect(initialDensity("?density=compact", undefined)).toBe("compact");
    expect(initialDensity("?density=compact", storage({ [densityStorageKey("compact")]: "huge" }))).toBe("compact");
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(initialDensity("?density=compact", throwing)).toBe("compact");
  });
});
