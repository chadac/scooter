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
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write goose's config.yaml under `home` (its $HOME), enabling developer. */
export function writeGooseConfig(home: string): void {
  const dir = join(home, ".config", "goose");
  mkdirSync(dir, { recursive: true });
  // Minimal config: enable the bundled developer extension. goose then exposes
  // its shell/edit/read/write tools, which its ACP server redirects to the
  // client (our sandbox exec) because the developer extension is enabled.
  const yaml = [
    "extensions:",
    "  developer:",
    "    enabled: true",
    "    type: builtin",
    "    name: developer",
    "    display_name: Developer",
    "    timeout: 300",
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.yaml"), yaml, "utf8");
}
