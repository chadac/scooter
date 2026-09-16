/**
 * goose config.yaml — best-effort; ACP sessions never read it (we always pass
 * mcpServers). `developer` is enabled by `--with-builtin` in index.ts, not here.
 * The `available_tools` allowlist never reaches goose, so `tree`/`read_image`
 * still run locally. Why, and why this file is kept: PR #524.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatError, logger } from "../log.js";

const log = logger("agent-host");

/** The developer-extension tools that goose's AcpTools redirects to the ACP
 *  client (the sandbox): read/write/edit/shell. Excludes tree + read_image,
 *  which AcpTools does NOT redirect (they'd run locally in the agent-host pod). */
const SANDBOX_ROUTED_TOOLS = ["read", "write", "edit", "shell"];

/** Write goose's config.yaml under `home` (its $HOME), enabling developer with
 *  only the sandbox-routed tools available. */
export function writeGooseConfig(home: string): void {
  const dir = join(home, ".config", "goose");
  mkdirSync(dir, { recursive: true });
  const yaml = [
    "extensions:",
    "  developer:",
    "    enabled: true",
    "    type: builtin",
    "    name: developer",
    "    display_name: Developer",
    "    timeout: 300",
    // Allowlist -> only the tools goose's AcpTools redirects to the sandbox.
    // tree/read_image are omitted so the agent can't run them locally.
    "    available_tools:",
    ...SANDBOX_ROUTED_TOOLS.map((t) => `      - ${t}`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.yaml"), yaml, "utf8");
}

/**
 * Write the config; fatal=true rejects startup on an unset/unwritable $HOME —
 * goose keeps its session db there, so that is a broken deployment. PR #524.
 */
export function ensureGooseConfig(
  home: string | undefined,
  opts: { fatal: boolean },
): void {
  if (!home) {
    if (opts.fatal) {
      throw new Error(
        "goose config: $HOME is unset on a real deployment — goose keeps its session " +
          "db and state under $HOME, so it cannot run correctly. Refusing to start.",
      );
    }
    return; // fake/dev: nothing to configure
  }
  try {
    writeGooseConfig(home);
    log.info("wrote goose config.yaml (ignored by ACP sessions; developer comes from --with-builtin)", {
      path: join(home, ".config", "goose"),
    });
  } catch (e) {
    if (opts.fatal) {
      throw new Error(
        `goose config: failed to write ${home}/.config/goose — $HOME is unusable, so ` +
          `goose cannot keep its session db or state. Refusing to start. ` +
          `Cause: ${(e as Error)?.message ?? e}`,
        { cause: e },
      );
    }
    log.warn("failed to write goose config (non-fatal, fake sandbox)", { error: formatError(e) });
  }
}
