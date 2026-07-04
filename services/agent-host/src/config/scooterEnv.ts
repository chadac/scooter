/**
 * Parse the SCOOTER_ENV channel — the deployment's extra sandbox env vars
 * (`deployTools.env` in kubenix) that the agent-host sets on every sandbox pod.
 *
 * The value is JSON (`builtins.toJSON` of the attrset), which round-trips every
 * value LOSSLESSLY — including a multi-line NIX_CONFIG, or a value containing `;`
 * / `=`. The old encoding was a flat `k=v;k=v` string, which could not carry a
 * newline: the delimiter split it and the parser's per-chunk trim() ate the
 * newlines, so a multi-line NIX_CONFIG reached nix as a single line with literal
 * `\n` (the bug). We still accept the legacy `k=v;k=v` form for a mixed-version
 * rollout, but ONLY the JSON form can carry multi-line values.
 */
export interface EnvVar {
  name: string;
  value: string;
}

export function parseScooterEnv(raw: string | undefined): EnvVar[] {
  const s = (raw ?? "").trim();
  if (!s) return [];

  // JSON form (current): {"NIX_CONFIG":"a\nb","FOO":"x"} — lossless. Any value that
  // opens like JSON (`{`, `[`, `"`) is treated as JSON: a well-formed object yields
  // its entries; anything else (array, string, malformed) yields [] rather than
  // being mis-parsed by the legacy k=v splitter or crashing the host.
  if (/^[{["]/.test(s)) {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return [];
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>)
      // Coerce each value to a string; JSON already preserved newlines/`;`/`=`.
      .map(([name, value]) => ({ name, value: String(value ?? "") }))
      .filter((e) => e.name);
  }

  // Legacy form (k=v;k=v): kept for backward compatibility. Cannot carry a newline
  // or a `;` in a value — those deployments must migrate to the JSON form. We
  // deliberately do NOT trim the value (only the chunk boundaries are ambiguous),
  // so a legacy single-line value is preserved as-is after the first `=`.
  return s
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? { name: kv, value: "" } : { name: kv.slice(0, i), value: kv.slice(i + 1) };
    })
    .filter((e) => e.name);
}
