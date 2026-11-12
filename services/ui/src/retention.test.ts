import { describe, expect, it } from "vitest";

import { LIFETIMES, lifetimeChoices, lifetimeLabel, parseLifetime, splitLifetime } from "./retention.js";

describe("retention", () => {
  it("labels a lifetime in its largest even unit", () => {
    expect(lifetimeLabel(0)).toBe("never");
    expect(lifetimeLabel(1)).toBe("1 hour");
    expect(lifetimeLabel(36)).toBe("36 hours");
    expect(lifetimeLabel(24)).toBe("1 day");
    expect(lifetimeLabel(72)).toBe("3 days");
    expect(lifetimeLabel(168)).toBe("1 week");
    expect(lifetimeLabel(336)).toBe("2 weeks");
    expect(lifetimeLabel(720)).toBe("30 days");
  });

  it("slots a custom lifetime among the presets by length", () => {
    expect(lifetimeChoices()).toBe(LIFETIMES);
    expect(lifetimeChoices(24)).toBe(LIFETIMES);
    expect(lifetimeChoices(336).map(([h]) => h)).toEqual([0, 24, 168, 336, 720]);
    expect(lifetimeChoices(1).map(([h]) => h)).toEqual([0, 1, 24, 168, 720]);
  });

  it("splits hours into the form's amount and unit", () => {
    expect(splitLifetime(336)).toEqual({ amount: 2, unit: "weeks" });
    expect(splitLifetime(72)).toEqual({ amount: 3, unit: "days" });
    expect(splitLifetime(5)).toEqual({ amount: 5, unit: "hours" });
  });

  it("accepts whole amounts from 1 hour to 10 years", () => {
    expect(parseLifetime("3", "days")).toEqual({ hours: 72 });
    expect(parseLifetime(" 2 ", "weeks")).toEqual({ hours: 336 });
    expect(parseLifetime("87600", "hours")).toEqual({ hours: 87600 });
    for (const bad of ["", "0", "-1", "1.5", "abc"]) expect(parseLifetime(bad, "days")).toHaveProperty("error");
    expect(parseLifetime("522", "weeks")).toEqual({ error: "At most 10 years" });
  });
});
