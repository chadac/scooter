import { describe, expect, it } from "vitest";

import { LIFETIMES, lifetimeChoices, lifetimeLabel, parseLifetime, splitLifetime, timeLeft } from "./retention.js";

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

  it("shows time left only inside the warning window", () => {
    const H = 3_600_000;
    // 30 days: the window is 3 days.
    const month = { at: 720 * H, hours: 720 };
    expect(timeLeft(month, 0)).toBeUndefined();
    expect(timeLeft(month, 720 * H - 73 * H)).toBeUndefined();
    expect(timeLeft(month, 720 * H - 72 * H)).toBe("3d");
    expect(timeLeft(month, 720 * H - 47 * H)).toBe("1d");
    expect(timeLeft(month, 720 * H - 5.5 * H)).toBe("5h");
    expect(timeLeft(month, 720 * H - 0.5 * H)).toBe("<1h");
    // Past due waits for the next sweep.
    expect(timeLeft(month, 721 * H)).toBe("<1h");
    // Short lifetimes still warn a day ahead.
    expect(timeLeft({ at: 24 * H, hours: 24 }, 0)).toBe("1d");
    expect(timeLeft({ at: 24 * H, hours: 24 }, 1)).toBe("23h");
  });
});
