/**
 * goose config — ensure the `developer` extension is ENABLED.
 *
 * Why this matters: goose's ACP server only redirects file/shell tools to the
 * ACP client (our sandbox-backed fs/terminal handlers) when the developer
 * extension is enabled — see goose's apply_acp_extension_overrides, which
 * REPLACES the developer extension's client with AcpTools iff
 * is_extension_enabled("developer"). With no config, that flag defaults to
 * false, so goose runs its built-in shell/edit tools LOCALLY (in the agent-host
 * pod) instead of in the sandbox.
 *
 * So we write goose's config.yaml (at $HOME/.config/goose/config.yaml) with the
 * developer extension enabled. Combined with the client capabilities we
 * advertise on initialize (fs + terminal), goose then routes every shell/file
 * tool call to our ACP handlers -> the sandbox.
 *
 * IMPORTANT — `available_tools` (allowlist): goose's AcpTools only REDIRECTS
 * read/write/edit/shell to the ACP client; `tree` and `read_image` fall through
 * to goose's LOCAL developer impl (std::fs in the agent-host pod, not the
 * sandbox) — so a `tree`/list would show the wrong filesystem. We restrict the
 * developer extension to ONLY the sandbox-routed tools via available_tools, so
 * the agent uses `shell` (ls/find) for listing — which goes to the sandbox.
 * (Empty available_tools = all tools; a non-empty list is an allowlist.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
