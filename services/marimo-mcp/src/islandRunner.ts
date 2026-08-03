/**
 * Runs the island-generation python (island.ts) in the pod's marimo env via an exec
 * runner supplied by the agent-host. Island generation must run in the pod (it needs
 * marimo installed) but must NOT go through the session-requiring HTTP path — so it's
 * a plain `uv run python -c <script>` exec, using the SAME uv env the marimo service
 * uses (UV_PYTHON pinned to the Nix python; downloads off). See the marimo-embed design.
 */

import { islandGenScript, parseIslandOutput, type IslandResult } from "./island.js";
import { MarimoError } from "./types.js";

/** Minimal exec surface: run a command in the pod, get stdout/stderr/exit. Mirrors the
 *  agent-host's ExecLike (webServiceRegistry). The runner decides HOW (k8s exec). */
export interface IslandExec {
  execute(req: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** How to invoke uv-run-python in the pod: the uv binary + the env it needs. The
 *  agent-host fills these from the marimo service's config (uv-nix uv, UV_PYTHON). */
export interface IslandUvConfig {
  /** Absolute path to the uv binary (the uv-nix uv). */
  uvBin: string;
  /** Env for the uv invocation — at least UV_PYTHON + UV_PYTHON_DOWNLOADS=never so uv
   *  uses the Nix python and never downloads the broken managed CPython. */
  env: Record<string, string>;
}

/**
 * Generate a marimo island for `code` by running the generator script in the pod.
 * Invokes `<uv> run --with marimo python -c <script>` with the marimo env, then parses
 * the marker JSON. Throws MarimoError on a non-zero exit or unparseable output (the
 * caller maps it to a tool error). `title` is passed through to the result.
 */
export async function generateIsland(
  exec: IslandExec,
  uv: IslandUvConfig,
  code: string,
  title?: string,
): Promise<IslandResult> {
  const script = islandGenScript(code);
  // Pass the env inline via `env` so the exec channel needn't inherit the unit's env:
  //   env K=V ... <uv> run --with marimo python -c <script>
  const envArgs = Object.entries(uv.env).map(([k, v]) => `${k}=${v}`);
  const r = await exec.execute({
    command: "env",
    args: [...envArgs, uv.uvBin, "run", "--with", "marimo", "python", "-c", script],
  });
  if (r.exitCode !== 0) {
    throw new MarimoError(
      `island generation failed (exit ${r.exitCode}): ${(r.stderr || r.stdout || "").slice(0, 400)}`,
      "http-error",
    );
  }
  const island = parseIslandOutput(r.stdout, title);
  if (!island) {
    throw new MarimoError(
      `island generation produced no island (marimo may have errored): ${(r.stderr || r.stdout || "").slice(0, 400)}`,
      "incomplete-stream",
    );
  }
  return island;
}
