"""Consumer-supplied Sandbox manifest overlay — a recursive patch applied on top of
the broker-generated per-conversation Sandbox, so a deployment can change the pod
manifest (nodeSelector, tolerations, extra env/volumes, annotations, resources, …)
WITHOUT patching Scooter's code.

Flow (mirrors deployTools.configFiles):
  kubenix `agentSandbox.deployTools.sandboxManifestOverlay` (an attrset)
    -> ConfigMap `sandbox-manifest-overlay` (one key, `overlay.yaml`, holding the patch)
    -> broker env `SANDBOX_MANIFEST_OVERLAY_CONFIGMAP=sandbox-manifest-overlay`
    -> broker reads it on EVERY create (no caching, so a ConfigMap edit lands on the
       next conversation without a restart), parses the patch, and `apply_overlay`s it
       onto the dict returned by `sandbox_manifest()` right before the Sandbox is made.

Merge semantics (decided in design):
  - DEEP merge: nested dicts are merged recursively (not replaced).
  - SCALARS: an overlay scalar replaces the base scalar.
  - LISTS: STRATEGIC merge by a merge key — items with a matching `name` are merged
    (like kubectl strategic patch on containers/env/volumes/volumeMounts); items with
    no `name`, or a `name` not present in the base, are appended. This lets a
    deployment override a single env var / volume by name without restating the rest.
  - SCOPE: the overlay may touch ANY path in the manifest (whole-manifest deep).
  - PRECEDENCE: overlay wins EXCEPT for a PROTECTED set of Scooter-critical fields,
    which are re-asserted from the base AFTER the merge (see PROTECTED_PATHS), so a bad
    overlay can't detach the SA, drop the broker token, break the PVCs, or unset the
    identity env that the conversation depends on.
"""

from __future__ import annotations

from typing import Any

# The merge key used for strategic list merges — an item in an overlay list is matched
# to a base item by this field (k8s uses `name` for containers/env/volumes/mounts).
LIST_MERGE_KEY = "name"

# Dotted paths (into the merged manifest) that Scooter OWNS: after the overlay merge,
# these are forced back to the broker-generated value so a consumer patch can't break
# the conversation's identity / auth / storage wiring. A path segment `key[name=X]`
# selects the list item whose `name` == X (so a single env var / volume / mount is
# protected in place, leaving the consumer's other list additions intact).
#
# NOTE: env is protected per-VARIABLE (individual env[name=…] entries), NOT the whole
# env list — so a deployment can still ADD env while the identity/broker vars stay
# authoritative.
PROTECTED_PATHS: tuple[str, ...] = (
    "apiVersion",
    "kind",
    "metadata.name",
    "spec.podTemplate.spec.serviceAccountName",
    "spec.podTemplate.spec.automountServiceAccountToken",
    "spec.podTemplate.spec.volumes[name=broker-token]",
    "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=broker-token]",
    "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=workspace]",
    "spec.volumeClaimTemplates",
    # Identity / broker env — protected per-variable (each env[name=…] restored in place).
    "spec.podTemplate.spec.containers[name=sandbox].env[name=CONVERSATION_ID]",
    "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_URL]",
    "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_TOKEN_PATH]",
)


class OverlayError(ValueError):
    """The overlay payload is malformed (not a mapping, unparseable YAML/JSON, or a
    type that can't merge onto the base at some path). Raised so the caller can FAIL
    LOUDLY — a silently-dropped overlay would look like it "didn't take"."""


def parse_overlay(raw: str) -> dict[str, Any]:
    """Parse the ConfigMap's overlay payload (YAML — a superset of JSON) into a dict.

    Empty / whitespace -> `{}` (a no-op overlay). A non-mapping top level (list, scalar)
    or a YAML/JSON syntax error -> OverlayError. The returned dict is the patch to merge
    onto the whole Sandbox manifest.
    """
    import yaml  # PyYAML; a JSON document is valid YAML, so this handles both.

    if not raw or not raw.strip():
        return {}
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        raise OverlayError(f"manifest overlay is not valid YAML/JSON: {e}") from e
    if parsed is None:
        return {}
    if not isinstance(parsed, dict):
        raise OverlayError(
            f"manifest overlay must be a mapping at the top level, got {type(parsed).__name__}"
        )
    return parsed


def deep_merge(base: Any, overlay: Any) -> Any:
    """Recursively merge `overlay` onto `base` and return the result (does NOT mutate
    either input).

    - dict + dict  -> key-wise deep merge (recurse on shared keys, add overlay-only keys).
    - list + list  -> strategic merge by LIST_MERGE_KEY (see module docstring):
                        * base item and overlay item sharing a `name` -> deep_merge them,
                        * overlay item whose `name` is absent from base -> appended,
                        * overlay item with NO `name` -> appended,
                        * base items not named by the overlay -> kept as-is.
    - otherwise    -> overlay replaces base (scalars, or a type change).

    A type mismatch that can't be merged sensibly (e.g. overlay dict onto base list) is
    an OverlayError, not a silent replace — that's almost always a consumer mistake.
    """
    # dict + dict -> key-wise deep merge.
    if isinstance(base, dict) and isinstance(overlay, dict):
        out: dict[str, Any] = dict(base)
        for k, ov in overlay.items():
            out[k] = deep_merge(base[k], ov) if k in base else _copy(ov)
        return out

    # list + list -> strategic merge by LIST_MERGE_KEY.
    if isinstance(base, list) and isinstance(overlay, list):
        return _merge_lists(base, overlay)

    # A container-vs-scalar (or list-vs-dict) mismatch is a consumer mistake, not a
    # silent replace. A scalar replacing a scalar (or either being None) is fine.
    if isinstance(base, (dict, list)) and type(base) is not type(overlay):
        raise OverlayError(
            f"overlay type {type(overlay).__name__} cannot merge onto base "
            f"type {type(base).__name__}"
        )

    # scalar (or type change scalar<->scalar) -> overlay wins.
    return _copy(overlay)


def _copy(v: Any) -> Any:
    """Deep-copy a plain JSON-ish value so the merge result never aliases an input."""
    if isinstance(v, dict):
        return {k: _copy(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_copy(x) for x in v]
    return v


def _merge_lists(base: list, overlay: list) -> list:
    """Strategic merge two lists by LIST_MERGE_KEY. Base items keep their order; an
    overlay item with a matching `name` is deep-merged in place; an overlay item that is
    unnamed, or names something absent from base, is appended (preserving overlay order).
    """
    out = [_copy(x) for x in base]
    # Index base items that carry the merge key, so an overlay can target them.
    index: dict[Any, int] = {
        item[LIST_MERGE_KEY]: i
        for i, item in enumerate(out)
        if isinstance(item, dict) and LIST_MERGE_KEY in item
    }
    for ov in overlay:
        key = ov.get(LIST_MERGE_KEY) if isinstance(ov, dict) else None
        if key is not None and key in index:
            i = index[key]
            out[i] = deep_merge(out[i], ov)
        else:
            out.append(_copy(ov))
    return out


def reassert_protected(base: dict[str, Any], merged: dict[str, Any]) -> dict[str, Any]:
    """After the merge, force every PROTECTED_PATHS value back to what `base` (the
    broker-generated manifest) had — so a consumer overlay can override anything EXCEPT
    Scooter's identity/auth/storage wiring. Returns the corrected manifest (new dict).

    A protected path that doesn't exist in `base` is skipped (nothing to re-assert). A
    protected list-item path re-asserts just that item (matched by `name`), leaving the
    consumer's other list additions intact.
    """
    out = _copy(merged)
    for path in PROTECTED_PATHS:
        segs = _parse_path(path)
        base_val, base_found = _get_path(base, segs)
        if not base_found:
            # Scooter didn't set this in the base (e.g. no scooter-rw mount) — there's
            # nothing authoritative to restore, so leave whatever the overlay did.
            continue
        _set_path(out, segs, base_val)
    return out


def apply_overlay(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """The public entry point: `reassert_protected(base, deep_merge(base, overlay))`.

    `overlay == {}` returns `base` unchanged (fast path). Never mutates `base`.
    """
    if not overlay:
        return base
    return reassert_protected(base, deep_merge(base, overlay))


# --- protected-path resolution ------------------------------------------------
#
# A path is dotted; a segment may be `key` (a dict key) or `key[name=X]` (the item of
# the list at `key` whose LIST_MERGE_KEY == X). Parsed to a list of _Seg.

from dataclasses import dataclass  # noqa: E402  (kept next to its only users)


@dataclass(frozen=True)
class _Seg:
    key: str
    sel: str | None = None  # the `name` selector for a list item, or None for a dict key


def _parse_path(path: str) -> list[_Seg]:
    segs: list[_Seg] = []
    for raw in path.split("."):
        if raw.endswith("]") and "[name=" in raw:
            key, rest = raw.split("[name=", 1)
            segs.append(_Seg(key=key, sel=rest[:-1]))  # strip trailing ']'
        else:
            segs.append(_Seg(key=raw))
    return segs


def _get_path(root: Any, segs: list[_Seg]) -> tuple[Any, bool]:
    """Resolve `segs` in `root`. Returns (value, found). `found` is False if any segment
    is missing (a key absent, or no list item matches the `name` selector)."""
    cur: Any = root
    for seg in segs:
        if not isinstance(cur, dict) or seg.key not in cur:
            return None, False
        cur = cur[seg.key]
        if seg.sel is not None:
            if not isinstance(cur, list):
                return None, False
            match = next(
                (it for it in cur if isinstance(it, dict) and it.get(LIST_MERGE_KEY) == seg.sel),
                None,
            )
            if match is None:
                return None, False
            cur = match
    return cur, True


def _set_path(root: Any, segs: list[_Seg], value: Any) -> None:
    """Set `segs` in `root` to a fresh copy of `value`, creating intermediate dicts as
    needed. For a list-item leaf (`key[name=X]`), replace the matching item, or append
    the value if no item matches (so a dropped protected item is restored)."""
    cur: Any = root
    for seg in segs[:-1]:
        nxt = cur.get(seg.key) if isinstance(cur, dict) else None
        if not isinstance(nxt, (dict, list)):
            nxt = {}
            cur[seg.key] = nxt
        cur = _resolve_selector(nxt, seg) if seg.sel is not None else nxt

    leaf = segs[-1]
    if leaf.sel is None:
        cur[leaf.key] = _copy(value)
        return
    lst = cur.get(leaf.key)
    if not isinstance(lst, list):
        cur[leaf.key] = [_copy(value)]
        return
    for i, it in enumerate(lst):
        if isinstance(it, dict) and it.get(LIST_MERGE_KEY) == leaf.sel:
            lst[i] = _copy(value)
            return
    lst.append(_copy(value))


def _resolve_selector(lst: Any, seg: _Seg) -> dict:
    """Return the list item selected by `seg` (create + append it if absent), so a
    mid-path `key[name=X]` segment can be traversed for setting."""
    if isinstance(lst, list):
        for it in lst:
            if isinstance(it, dict) and it.get(LIST_MERGE_KEY) == seg.sel:
                return it
    item = {LIST_MERGE_KEY: seg.sel}
    if isinstance(lst, list):
        lst.append(item)
    return item
