import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** VS Code settings Scooter needs; application-scoped, so they must live in the USER settings.json. */
export const REQUIRED_SETTINGS: Record<string, unknown> = {
  // Agent Host sessions without a GitHub sign-in: the Scooter agent advertises no GitHub resource.
  "chat.agentHost.allowSignedOutWhenUsable": true,
  // New chats default to the Scooter agent host instead of a local Copilot session.
  "chat.editor.localAgent.enabled": false,
  // The chat view picks its agent on creation; keep it closed until Scooter has registered.
  "workbench.secondarySideBar.defaultVisibility": "hidden",
};

/**
 * Add any missing REQUIRED_SETTINGS to a user settings.json, never clobbering it: a key already
 * present (any value) is left alone, and a file that is not plain JSON (VS Code allows comments)
 * is left untouched with a warning rather than rewritten.
 */
export function ensureSettings(path: string, warn: (msg: string) => void = console.error): "created" | "updated" | "unchanged" | "skipped" {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(REQUIRED_SETTINGS, null, 2) + "\n");
    return "created";
  }
  const raw = readFileSync(path, "utf8");
  const missing = Object.keys(REQUIRED_SETTINGS).filter((k) => !raw.includes(JSON.stringify(k)));
  if (missing.length === 0) return "unchanged";
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    warn(`${path} is not plain JSON; add ${missing.map((k) => `"${k}": ${JSON.stringify(REQUIRED_SETTINGS[k])}`).join(", ")} by hand`);
    return "skipped";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`${path} is not a JSON object; leaving it alone`);
    return "skipped";
  }
  const next = { ...(parsed as Record<string, unknown>) };
  for (const k of missing) next[k] = REQUIRED_SETTINGS[k];
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return "updated";
}
