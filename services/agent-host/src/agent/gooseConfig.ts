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
 * `available_tools` (allowlist) — INEFFECTIVE on current goose, kept as intent:
 * goose's AcpTools only REDIRECTS read/write/edit/shell to the ACP client; `tree`
 * and `read_image` fall through to goose's LOCAL developer impl (std::fs in the
 * agent-host pod, not the sandbox) — so a `tree`/list would show the WRONG
 * filesystem. We'd like to restrict the developer extension to only the
 * sandbox-routed tools via available_tools — BUT goose (verified on 1.28.0)
 * rewrites config.yaml on every launch, expanding all bundled extensions and
 * resetting every `available_tools` back to `[]` (= all tools). So the allowlist
 * we write here does NOT survive; `tree`/`read_image` remain callable and run
 * locally. We still write it (harmless; correct for a goose that honors it), but
 * the ACTUAL guard against `tree` is an instruction in the agent's identity
 * prompt (see identityPrompt in skills.ts) telling it to use `shell` (ls/find)
 * for listing instead of the host-reading `tree`/`read_image` tools.
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

/**
 * Ensure goose's developer-enabled config exists — and FAIL LOUDLY when it can't
 * on a real deployment.
 *
 * Audit finding #1 (HIGH): without this config goose's developer extension
 * defaults to enabled=false, so it runs the agent's shell/file tools LOCALLY in
 * the agent-host pod instead of redirecting them to the per-conversation sandbox
 * — a silent isolation breach (the pod still passes /healthz). So:
 *   - fatal=true  (real goose):  a missing $HOME or a write failure THROWS, so
 *                                main() rejects and the process exits rather than
 *                                serving mis-isolated.
 *   - fatal=false (fake/dev):    best-effort no-op; there is no real goose to
 *                                mis-route, so a missing home / write failure is
 *                                swallowed (with a warning) and startup proceeds.
 */
export function ensureGooseConfig(
  home: string | undefined,
  opts: { fatal: boolean },
): void {
  if (!home) {
    if (opts.fatal) {
      throw new Error(
        "goose config: $HOME is unset on a real deployment — cannot enable the " +
          "developer extension, so goose would run tools in the agent-host pod " +
          "instead of the sandbox (isolation breach). Refusing to start.",
      );
    }
    return; // fake/dev: nothing to configure
  }
  try {
    writeGooseConfig(home);
    // eslint-disable-next-line no-console
    console.log(`[agent-host] wrote goose config (developer enabled) to ${home}/.config/goose`);
  } catch (e) {
    if (opts.fatal) {
      throw new Error(
        `goose config: failed to write ${home}/.config/goose — goose would run ` +
          `tools in the agent-host pod instead of the sandbox (isolation breach). ` +
          `Refusing to start. Cause: ${(e as Error)?.message ?? e}`,
        { cause: e },
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[agent-host] failed to write goose config (non-fatal, fake sandbox):", e);
  }
}
