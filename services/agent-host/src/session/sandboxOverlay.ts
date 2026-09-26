/**
 * Consumer-supplied Sandbox manifest overlay — a recursive patch applied on top of the
 * generated per-conversation Sandbox, so a deployment can change the pod manifest
 * (nodeSelector, tolerations, extra env/volumes, annotations, resources, …) WITHOUT
 * patching Scooter's code.
 *
 * This is also how a CONTRIB reaches every sandbox pod: modules/platform.nix renders
 * `agentSandbox.sandboxPod.*` into a second key of the same ConfigMap, merged under the
 * consumer's patch. One splice mechanism, not two — the provisioner knows nothing about
 * contribs. Why: PR #640.
 *
 * Flow (mirrors deployTools.configFiles):
 *   kubenix `agentSandbox.deployTools.sandboxManifestOverlay` (an attrset)
 *     -> ConfigMap `sandbox-manifest-overlay` (key `overlay.yaml`, holding the patch;
 *        `contrib.yaml` holds the contribs' parts in the same shape)
 *     -> agent-host env `SANDBOX_MANIFEST_OVERLAY_CONFIGMAP=sandbox-manifest-overlay`
 *     -> read on EVERY create (no caching, so a ConfigMap edit lands on the next
 *        conversation without a restart), parsed, and applied to the dict returned by
 *        `sandboxManifest()` right before the Sandbox is created.
 *
 * Merge semantics:
 *   - DEEP merge: nested objects merge recursively (not replaced).
 *   - SCALARS: an overlay scalar replaces the base scalar.
 *   - ARRAYS: STRATEGIC merge by a merge key — items with a matching `name` are merged
 *     (like kubectl strategic patch on containers/env/volumes/volumeMounts); items with
 *     no `name`, or a `name` not present in the base, are appended. This lets a
 *     deployment override a single env var / volume by name without restating the rest.
 *   - SCOPE: the overlay may touch ANY path in the manifest.
 *   - PRECEDENCE: overlay wins EXCEPT for a PROTECTED set of Scooter-critical fields,
 *     re-asserted from the base AFTER the merge (see PROTECTED_PATHS), so a bad overlay
 *     cannot detach the SA, drop the broker token, break the PVCs, or unset the identity
 *     env the conversation depends on.
 */

import { loadYaml } from "@kubernetes/client-node";

type Json = unknown;
type JsonObject = Record<string, unknown>;

/** The merge key for strategic array merges — k8s uses `name` for
 *  containers/env/volumes/volumeMounts. */
const LIST_MERGE_KEY = "name";

/**
 * Dotted paths (into the merged manifest) that Scooter OWNS: after the merge these are
 * forced back to the generated value, so a consumer patch cannot break the
 * conversation's identity / auth / storage wiring. A segment `key[name=X]` selects the
 * array item whose `name` === X, so a single env var / volume / mount is protected in
 * place, leaving the consumer's other additions intact.
 *
 * NOTE: env is protected per-VARIABLE, NOT as a whole list — a deployment can still ADD
 * env while the identity/broker vars stay authoritative.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "apiVersion",
  "kind",
  "metadata.name",
  "spec.podTemplate.spec.serviceAccountName",
  "spec.podTemplate.spec.automountServiceAccountToken",
  "spec.podTemplate.spec.volumes[name=broker-token]",
  "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=broker-token]",
  "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=workspace]",
  "spec.volumeClaimTemplates",
  // Identity / broker env — protected per-variable (each env[name=…] restored in place).
  "spec.podTemplate.spec.containers[name=sandbox].env[name=CONVERSATION_ID]",
  "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_URL]",
  "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_TOKEN_PATH]",
];

/** The overlay payload is malformed (unparseable, not a mapping, or a type that cannot
 *  merge onto the base). Thrown so the caller FAILS LOUDLY — a silently-dropped overlay
 *  looks to a deployment like it "didn't take". */
export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayError";
  }
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-copy a plain JSON-ish value so a merge result never aliases an input. */
function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as unknown as T;
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out as unknown as T;
  }
  return v;
}

/**
 * Parse the ConfigMap's overlay payload into an object. YAML, which is a superset of
 * JSON — kubenix writes JSON, but a human editing the ConfigMap will write YAML.
 *
 * Empty/whitespace -> `{}` (a no-op overlay). A non-mapping top level (array, scalar) or
 * a syntax error -> OverlayError.
 */
export function parseOverlay(raw: string | undefined | null): JsonObject {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = loadYaml<unknown>(raw);
  } catch (e) {
    throw new OverlayError(`manifest overlay is not valid YAML/JSON: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isObject(parsed)) {
    throw new OverlayError(
      `manifest overlay must be a mapping at the top level, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed;
}

/**
 * Recursively merge `overlay` onto `base`, returning a new value (never mutates either).
 *
 * - object + object -> key-wise deep merge
 * - array + array   -> strategic merge by LIST_MERGE_KEY
 * - otherwise       -> overlay replaces base
 *
 * A container-vs-scalar (or array-vs-object) mismatch is an OverlayError rather than a
 * silent replace: that is almost always a consumer mistake.
 */
export function deepMerge(base: Json, overlay: Json): Json {
  if (isObject(base) && isObject(overlay)) {
    const out: JsonObject = { ...base };
    for (const [k, ov] of Object.entries(overlay)) {
      out[k] = k in base ? deepMerge(base[k], ov) : copy(ov);
    }
    return out;
  }

  if (Array.isArray(base) && Array.isArray(overlay)) return mergeLists(base, overlay);

  // A scalar replacing a scalar (or either being null) is fine; a shape change between
  // containers is not.
  const baseIsContainer = isObject(base) || Array.isArray(base);
  const sameShape = Array.isArray(base) === Array.isArray(overlay) && isObject(base) === isObject(overlay);
  if (baseIsContainer && !sameShape) {
    throw new OverlayError(
      `overlay type ${Array.isArray(overlay) ? "array" : typeof overlay} cannot merge onto ` +
        `base type ${Array.isArray(base) ? "array" : typeof base}`,
    );
  }

  return copy(overlay);
}

/**
 * Strategic-merge two arrays by LIST_MERGE_KEY. Base items keep their order; an overlay
 * item with a matching `name` is deep-merged in place; an overlay item that is unnamed,
 * or names something absent from base, is appended (preserving overlay order).
 */
function mergeLists(base: unknown[], overlay: unknown[]): unknown[] {
  const out = base.map(copy);
  const index = new Map<unknown, number>();
  out.forEach((item, i) => {
    if (isObject(item) && LIST_MERGE_KEY in item) index.set(item[LIST_MERGE_KEY], i);
  });
  for (const ov of overlay) {
    const key = isObject(ov) ? ov[LIST_MERGE_KEY] : undefined;
    const at = key !== undefined ? index.get(key) : undefined;
    if (at !== undefined) out[at] = deepMerge(out[at], ov);
    else out.push(copy(ov));
  }
  return out;
}

// --- protected-path resolution ----------------------------------------------
// A path is dotted; a segment is `key` (an object key) or `key[name=X]` (the item of the
// array at `key` whose LIST_MERGE_KEY === X).

interface Seg {
  key: string;
  sel?: string;
}

function parsePath(path: string): Seg[] {
  return path.split(".").map((raw) => {
    if (raw.endsWith("]") && raw.includes("[name=")) {
      const [key, rest] = raw.split("[name=", 2);
      return { key, sel: rest.slice(0, -1) };
    }
    return { key: raw };
  });
}

/** Resolve `segs` in `root`. `found` is false if any segment is missing (an absent key,
 *  or no array item matching the `name` selector). */
function getPath(root: Json, segs: Seg[]): { value: Json; found: boolean } {
  let cur: Json = root;
  for (const seg of segs) {
    if (!isObject(cur) || !(seg.key in cur)) return { value: undefined, found: false };
    cur = cur[seg.key];
    if (seg.sel !== undefined) {
      if (!Array.isArray(cur)) return { value: undefined, found: false };
      const match = cur.find((it) => isObject(it) && it[LIST_MERGE_KEY] === seg.sel);
      if (match === undefined) return { value: undefined, found: false };
      cur = match;
    }
  }
  return { value: cur, found: true };
}

/** Return the array item selected by `seg`, creating + appending it when absent, so a
 *  mid-path `key[name=X]` can be traversed for setting. */
function resolveSelector(list: Json, seg: Seg): JsonObject {
  if (Array.isArray(list)) {
    const found = list.find((it) => isObject(it) && it[LIST_MERGE_KEY] === seg.sel);
    if (isObject(found)) return found;
  }
  const item: JsonObject = { [LIST_MERGE_KEY]: seg.sel };
  if (Array.isArray(list)) list.push(item);
  return item;
}

/** Set `segs` in `root` to a fresh copy of `value`, creating intermediate objects as
 *  needed. For an array-item leaf, replace the matching item — or append it, so a
 *  protected item the overlay DROPPED is restored. */
function setPath(root: JsonObject, segs: Seg[], value: Json): void {
  let cur: JsonObject = root;
  for (const seg of segs.slice(0, -1)) {
    let next = cur[seg.key];
    if (!isObject(next) && !Array.isArray(next)) {
      next = {};
      cur[seg.key] = next;
    }
    cur = seg.sel !== undefined ? resolveSelector(next, seg) : (next as JsonObject);
  }

  const leaf = segs[segs.length - 1];
  if (leaf.sel === undefined) {
    cur[leaf.key] = copy(value);
    return;
  }
  const list = cur[leaf.key];
  if (!Array.isArray(list)) {
    cur[leaf.key] = [copy(value)];
    return;
  }
  const at = list.findIndex((it) => isObject(it) && it[LIST_MERGE_KEY] === leaf.sel);
  if (at >= 0) list[at] = copy(value);
  else list.push(copy(value));
}

/** Force every PROTECTED_PATHS value back to what `base` (the generated manifest) had.
 *  A protected path absent from `base` is skipped — there is nothing authoritative to
 *  restore, so whatever the overlay did stands. */
export function reassertProtected(base: JsonObject, merged: JsonObject): JsonObject {
  const out = copy(merged);
  for (const path of PROTECTED_PATHS) {
    const segs = parsePath(path);
    const { value, found } = getPath(base, segs);
    if (!found) continue;
    setPath(out, segs, value);
  }
  return out;
}

/** The public entry point: `reassertProtected(base, deepMerge(base, overlay))`.
 *  An empty overlay returns `base` unchanged (fast path). Never mutates `base`. */
export function applyOverlay(base: JsonObject, overlay: JsonObject): JsonObject {
  if (!overlay || Object.keys(overlay).length === 0) return base;
  return reassertProtected(base, deepMerge(base, overlay) as JsonObject);
}
