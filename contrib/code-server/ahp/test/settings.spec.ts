import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_SETTINGS, ensureSettings } from "../src/settings.js";

const KEY = "chat.agentHost.allowSignedOutWhenUsable";
const file = () => join(mkdtempSync(join(tmpdir(), "vsc-settings-")), "User", "settings.json");

describe("ensureSettings", () => {
  it("creates a missing settings file", () => {
    const f = file();
    expect(ensureSettings(f)).toBe("created");
    expect(JSON.parse(readFileSync(f, "utf8"))[KEY]).toBe(true);
  });
  it("adds the key to existing JSON, keeping the user's settings", () => {
    const f = file();
    ensureSettings(f);
    writeFileSync(f, JSON.stringify({ "editor.fontSize": 15 }));
    expect(ensureSettings(f)).toBe("updated");
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ "editor.fontSize": 15, ...REQUIRED_SETTINGS });
  });
  it("defaults chat to the Scooter agent host, not a local session", () => {
    const f = file();
    ensureSettings(f);
    const s = JSON.parse(readFileSync(f, "utf8"));
    expect(s["chat.editor.localAgent.enabled"]).toBe(false);
    expect(s["workbench.secondarySideBar.defaultVisibility"]).toBe("hidden");
  });
  it("adds settings missing from a file written by an older version", () => {
    const f = file();
    ensureSettings(f);
    writeFileSync(f, JSON.stringify({ [KEY]: true }));
    expect(ensureSettings(f)).toBe("updated");
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(REQUIRED_SETTINGS);
  });
  it("respects a value the user already set", () => {
    const f = file();
    ensureSettings(f);
    writeFileSync(f, JSON.stringify({ ...REQUIRED_SETTINGS, [KEY]: false }));
    expect(ensureSettings(f)).toBe("unchanged");
    expect(JSON.parse(readFileSync(f, "utf8"))[KEY]).toBe(false);
  });
  it("never rewrites a JSONC file with comments", () => {
    const f = file();
    ensureSettings(f);
    const jsonc = '{\n  // mine\n  "editor.fontSize": 15\n}\n';
    writeFileSync(f, jsonc);
    const warnings: string[] = [];
    expect(ensureSettings(f, (m) => warnings.push(m))).toBe("skipped");
    expect(readFileSync(f, "utf8")).toBe(jsonc);
    expect(warnings[0]).toContain(KEY);
  });
});
