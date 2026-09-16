/**
 * goose config — a best-effort config.yaml enabling the `developer` extension.
 *
 * NOT the mechanism that enables developer for ACP sessions. Verified on goose
 * 1.47.0: `initial_session_extensions` reads config.yaml only in its
 * `mcp_servers.is_empty()` branch, and agent-host always passes the scooter-env
 * MCP server — so for every real session this file is never read. The developer
 * extension is enabled by the `--with-builtin developer` flag in index.ts's
 * agent launch config; that flag, not this file, is what routes shell/file tools
 * through AcpTools to the sandbox. See PR #TODO.
 *
 * Kept because it is correct for a goose that does consult config.yaml (e.g. a
 * session started with no mcpServers) and because ensureGooseConfig's fatal
 * unwritable-$HOME check is a cheap startup canary for a broken HOME mount.
 *
 * `available_tools` (allowlist) — INEFFECTIVE, kept as intent. goose's AcpTools
 * only REDIRECTS read/write/edit/shell to the ACP client; `tree` and `read_image`
 * fall through to the LOCAL developer impl (std::fs in the agent-host pod, not the
 * sandbox), so a `tree`/list would show the WRONG filesystem. Restricting the
 * extension to the sandbox-routed tools would fix that — but the allowlist never
 * reaches goose: on 1.28.0 goose rewrote config.yaml on launch and reset every
 * `available_tools` to `[]`, and on 1.47.0 the `--with-builtin` path builds the
 * extension via `builtin_to_extension_config`, which hardcodes
 * `available_tools: vec![]`. Either way `tree`/`read_image` stay callable and run
 * locally. The ACTUAL guard is an instruction in the agent's identity prompt (see
 * identityPrompt in skills.ts) telling it to use `shell` (ls/find) for listing.
 * An enforceable allowlist needs `_meta.enabledExtensions` on session/new — see
 * the follow-up issue.
 * (Empty available_tools = all tools; a non-empty list is an allowlist.)
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
 * Write the config and FAIL LOUDLY when it can't be written on a real deployment.
 *
 * This is NOT what enables developer for ACP sessions (see the header) — that is
 * the `--with-builtin developer` flag. What survives is the $HOME check: goose
 * keeps its session db and state under $HOME, so an unset or unwritable $HOME is
 * a broken deployment we want to reject at startup rather than discover per-turn.
 *   - fatal=true  (real goose):  a missing $HOME or a write failure THROWS, so
 *                                main() rejects and the process exits.
 *   - fatal=false (fake/dev):    best-effort no-op; there is no real goose, so a
 *                                missing home / write failure is swallowed (with
 *                                a warning) and startup proceeds.
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
    // NOT "developer enabled" — ACP sessions ignore this file (see the header).
    // The old wording claimed an effect it never had, on every single start.
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
